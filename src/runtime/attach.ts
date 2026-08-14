import type { RuntimeCatalogToolDefinition, RuntimeEvent } from "../types.js";
import { isRemotelyPublishable } from "./allowlist.js";
import {
  classifyDelivery,
  type DeliveryResult,
  DeliveryStatus,
  type RuntimeDeliveryStatus,
} from "./delivery-status.js";
import { RuntimeEventsPublisher, type RuntimeEventsPublisherOptions } from "./publisher.js";
import { nonNegative } from "./retry.js";
import { CatalogSnapshotsPublisher, normalizeSourceId } from "./snapshots.js";

const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 500;
/** Sustained churn re-arms the debounce forever; the max wait forces publication. */
const SNAPSHOT_MAX_WAIT_MULTIPLIER = 4;

export interface RuntimeEventSubscription {
  readonly droppedCount: number;
  unsubscribe(): void;
  flush(): Promise<void>;
}

export interface RatelRuntimeEvents {
  readonly sourceId: string;
  subscribe(
    handler: (batch: readonly RuntimeEvent[]) => void | PromiseLike<void>,
  ): RuntimeEventSubscription;
}

export interface RatelRuntimeCatalog {
  snapshot(): {
    readonly source_id: string;
    readonly tools: readonly RatelRuntimeCatalogToolDefinition[];
    readonly skills?: readonly unknown[];
  };
}

export interface RatelRuntimeCatalogToolDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly metadata?: unknown;
}

export interface RatelRuntime {
  readonly events: RatelRuntimeEvents;
  readonly catalog: RatelRuntimeCatalog;
}

export interface AttachOptions
  extends Omit<RuntimeEventsPublisherOptions, "apiKey" | "deliveryStatus"> {
  /** Project API key. Defaults to `RATEL_API_KEY`. */
  readonly apiKey?: string;
  /** Stable deployment source. Defaults to the Ratel runtime's OTel-derived source id. */
  readonly sourceId?: string;
  /** Quiet period after catalog churn before publication. Defaults to 500 ms. */
  readonly snapshotDebounceMs?: number;
  /** Maximum age of a durable catalog confirmation. Defaults to 5 minutes. */
  readonly snapshotReconcileIntervalMs?: number;
  /** Called only when a publisher's delivery outcome kind changes. */
  readonly onStatusChange?: (status: RuntimeDeliveryStatus) => void;
  /** Emit one warning per failing kind until it recovers. Defaults to true. */
  readonly warnOnFailure?: boolean;
}

export interface RuntimeAttachment {
  /** Current JSON-serializable delivery health. */
  status(): RuntimeDeliveryStatus;
  /** Probe event ingestion without mutating publisher queues. */
  verify(): Promise<DeliveryResult>;
  /** Deliver runtime work already accepted by this process. */
  flush(): Promise<void>;
  /** Stop accepting runtime work and deliver everything already accepted. */
  close(): Promise<void>;
}

const ATTACHMENTS = new WeakMap<object, RuntimeAttachment>();
const NOOP_ATTACHMENT: RuntimeAttachment = {
  status: () => ({
    overall: "degraded",
    events: {
      lastOutcome: classifyDelivery(undefined),
      lastAcceptedAt: null,
      lastAttemptAt: null,
      lastError: "runtime attachment could not be created",
      accepted: 0,
      rejected: 0,
      dropped: 0,
    },
    snapshots: {},
  }),
  verify: async () => classifyDelivery(undefined),
  flush: async () => {},
  close: async () => {},
};

/** Subscribe one Ratel runtime to fail-open Cloud delivery. */
export function attach(runtime: RatelRuntime, options: AttachOptions = {}): RuntimeAttachment {
  try {
    return attachRuntime(runtime, options);
  } catch {
    return NOOP_ATTACHMENT;
  }
}

function attachRuntime(runtime: RatelRuntime, options: AttachOptions): RuntimeAttachment {
  const existing = ATTACHMENTS.get(runtime);
  if (existing) return existing;

  const {
    apiKey = process.env.RATEL_API_KEY ?? "",
    sourceId: rawSourceId = runtime.events.sourceId,
    snapshotDebounceMs,
    snapshotReconcileIntervalMs,
    onStatusChange,
    warnOnFailure,
    ...delivery
  } = options;
  // One normalization at the boundary keeps both lanes on a single source identity.
  const sourceId = normalizeSourceId(rawSourceId);
  const enabled = process.env.RATEL_CLOUD_EVENTS?.trim().toLowerCase() !== "off";
  const deliveryStatus = new DeliveryStatus({
    enabled,
    ...(onStatusChange === undefined ? {} : { onStatusChange }),
    ...(warnOnFailure === undefined ? {} : { warnOnFailure }),
  });
  const publisher = new RuntimeEventsPublisher({ ...delivery, apiKey, deliveryStatus });
  const snapshots = new CatalogSnapshotsPublisher({
    apiKey,
    ...(delivery.baseUrl === undefined ? {} : { baseUrl: delivery.baseUrl }),
    ...(delivery.fetch === undefined ? {} : { fetch: delivery.fetch }),
    ...(delivery.timeoutMs === undefined ? {} : { timeoutMs: delivery.timeoutMs }),
    debounceMs: 0,
    ...(snapshotReconcileIntervalMs === undefined
      ? {}
      : { reconcileIntervalMs: snapshotReconcileIntervalMs }),
    ...(delivery.retry === undefined ? {} : { retry: delivery.retry }),
    ...(delivery.sleep === undefined ? {} : { sleep: delivery.sleep }),
    ...(delivery.onRejected === undefined ? {} : { onRejected: delivery.onRejected }),
    deliveryStatus,
  });
  const publishSnapshot = (): void => {
    try {
      const snapshot = runtime.catalog.snapshot();
      snapshots.publish({
        source_id: sourceId,
        tools: snapshot.tools.map(toCatalogTool),
      });
    } catch {
      // Snapshot observation is optional and must never affect the host operation.
    }
  };
  const debounceMs = nonNegative(snapshotDebounceMs, DEFAULT_SNAPSHOT_DEBOUNCE_MS);
  const maxWaitMs = debounceMs * SNAPSHOT_MAX_WAIT_MULTIPLIER;
  let snapshotDirty = false;
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  let snapshotMaxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  const flushDirtySnapshot = (): void => {
    if (snapshotTimer !== undefined) {
      clearTimeout(snapshotTimer);
      snapshotTimer = undefined;
    }
    if (snapshotMaxWaitTimer !== undefined) {
      clearTimeout(snapshotMaxWaitTimer);
      snapshotMaxWaitTimer = undefined;
    }
    if (!snapshotDirty) return;
    snapshotDirty = false;
    // The publisher drains on its own immediate unref'd schedule after publish.
    publishSnapshot();
  };
  const markSnapshotDirty = (): void => {
    snapshotDirty = true;
    if (snapshotTimer !== undefined) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
      snapshotTimer = undefined;
      flushDirtySnapshot();
    }, debounceMs);
    snapshotTimer.unref?.();
    if (debounceMs === 0 || snapshotMaxWaitTimer !== undefined) return;
    snapshotMaxWaitTimer = setTimeout(() => {
      snapshotMaxWaitTimer = undefined;
      flushDirtySnapshot();
    }, maxWaitMs);
    snapshotMaxWaitTimer.unref?.();
  };
  const subscription = runtime.events.subscribe((batch) => {
    for (const event of batch) {
      // Non-allowlisted types can carry local-only detail and never leave the process.
      if (!isRemotelyPublishable(event.type)) continue;
      publisher.publish(event.source_id === sourceId ? event : { ...event, source_id: sourceId });
    }
    if (batch.some((event) => event.type === "index_churn")) markSnapshotDirty();
  });
  markSnapshotDirty();

  let closePromise: Promise<void> | undefined;
  const flushPublishers = async (): Promise<void> => {
    flushDirtySnapshot();
    try {
      await Promise.all([publisher.flush(), snapshots.flush()]);
    } catch {
      // Publisher lifecycle is fail-open too.
    }
  };
  const flush = async (): Promise<void> => {
    try {
      await subscription.flush();
    } catch {
      // SDK delivery is observational and must not make host shutdown fail.
    }
    await flushPublishers();
  };
  const handle: RuntimeAttachment = {
    status: () => deliveryStatus.snapshot(),
    verify: () => publisher.verify(),
    flush,
    close: () => {
      closePromise ??= (async () => {
        await flush();
        try {
          subscription.unsubscribe();
        } catch {
          // Detach failures cannot escape into host shutdown.
        }
        ATTACHMENTS.delete(runtime);
        try {
          // One more drain captures envelopes the native queue delivered after unsubscribe.
          await Promise.all([publisher.flush(), snapshots.flush()]);
        } catch {
          // Publisher lifecycle is fail-open too.
        }
        try {
          // Sealing both publishers guarantees no request starts after close() resolves.
          await Promise.all([publisher.close(), snapshots.close()]);
        } catch {
          // Publisher lifecycle is fail-open too.
        }
      })();
      return closePromise;
    },
  };
  ATTACHMENTS.set(runtime, handle);
  return handle;
}

function toCatalogTool(tool: RatelRuntimeCatalogToolDefinition): RuntimeCatalogToolDefinition {
  return {
    id: tool.id,
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(isRecordOrNull(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
    ...(isRecordOrNull(tool.outputSchema) ? { outputSchema: tool.outputSchema } : {}),
    ...(isRecordOrNull(tool.metadata) ? { metadata: tool.metadata } : {}),
  };
}

function isRecordOrNull(value: unknown): value is Record<string, unknown> | null {
  return value === null || (typeof value === "object" && !Array.isArray(value));
}
