import type {
  RuntimeEvents,
  RuntimeEventSubscription as SdkRuntimeEventSubscription,
} from "@ratel-ai/sdk";
import type { RuntimeCatalogToolDefinition } from "../types.js";
import { isRemotelyPublishable } from "./allowlist.js";
import {
  type CloudDefinitionsAttachment,
  type CloudDefinitionsOverlaySource,
  type CloudDefinitionsRuntimeCatalog,
  createCloudDefinitionsSource,
} from "./cloud-definitions.js";
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

export type RuntimeEventSubscription = SdkRuntimeEventSubscription;

export type RatelRuntimeEvents = Pick<RuntimeEvents, "sourceId" | "subscribe">;

export interface RatelRuntimeCatalog extends CloudDefinitionsRuntimeCatalog {
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
  /** ⚠️ Experimental (ADR-0021). Retrieval-only description, published to Cloud. */
  readonly experimentalSearchableDescription?: string;
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
  /** Give Cloud ownership of Retrieval descriptions. Requires `@ratel-ai/sdk` >= 0.12.0. */
  readonly useCloudDefinitions?: boolean;
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

export interface CloudDefinitionsRuntimeAttachment extends RuntimeAttachment {
  /** Pull and apply changed Cloud-owned Retrieval descriptions. */
  refreshCloudDefinitions(): Promise<boolean>;
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
export function attach(
  runtime: RatelRuntime,
  options: AttachOptions & { readonly useCloudDefinitions: true },
): CloudDefinitionsRuntimeAttachment;
export function attach(runtime: RatelRuntime, options?: AttachOptions): RuntimeAttachment;
export function attach(
  runtime: RatelRuntime,
  options: AttachOptions = {},
): RuntimeAttachment | CloudDefinitionsRuntimeAttachment {
  try {
    if (!hasRuntimeEvents(runtime)) {
      warnMissingRuntimeEventsOnce();
      return options.useCloudDefinitions
        ? { ...NOOP_ATTACHMENT, refreshCloudDefinitions: async () => false }
        : NOOP_ATTACHMENT;
    }
    return attachRuntime(runtime, options);
  } catch {
    return options.useCloudDefinitions
      ? { ...NOOP_ATTACHMENT, refreshCloudDefinitions: async () => false }
      : NOOP_ATTACHMENT;
  }
}

function attachRuntime(runtime: RatelRuntime, options: AttachOptions): RuntimeAttachment {
  const existing = ATTACHMENTS.get(runtime);
  if (existing) {
    if (options.useCloudDefinitions) enableCloudDefinitions(runtime, existing, options);
    return existing;
  }

  const {
    apiKey = process.env.RATEL_API_KEY ?? "",
    sourceId: rawSourceId = runtime.events.sourceId,
    snapshotDebounceMs,
    snapshotReconcileIntervalMs,
    onStatusChange,
    warnOnFailure,
    useCloudDefinitions = false,
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
  const cloudDefinitions = new CloudDefinitionsController(runtime.catalog, warnOnFailure ?? true);

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
    if (cloudDefinitions.enabled) await cloudDefinitions.waitForInitialPull();
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
        cloudDefinitions.close();
      })();
      return closePromise;
    },
  };
  ATTACHMENTS.set(runtime, handle);
  CLOUD_DEFINITION_CONTROLLERS.set(runtime, cloudDefinitions);
  if (useCloudDefinitions) enableCloudDefinitions(runtime, handle, options);
  return handle;
}

const CLOUD_DEFINITION_CONTROLLERS = new WeakMap<object, CloudDefinitionsController>();

class CloudDefinitionsController {
  readonly #catalog: RatelRuntimeCatalog;
  readonly #warnOnFailure: boolean;
  #source: CloudDefinitionsOverlaySource | undefined;
  #attachment: CloudDefinitionsAttachment | undefined;
  #attaching: Promise<CloudDefinitionsAttachment | undefined> | undefined;
  #closed = false;
  #warningActive = false;

  constructor(catalog: RatelRuntimeCatalog, warnOnFailure: boolean) {
    this.#catalog = catalog;
    this.#warnOnFailure = warnOnFailure;
  }

  get enabled(): boolean {
    return this.#source !== undefined;
  }

  enable(source: CloudDefinitionsOverlaySource): void {
    if (this.#closed) return;
    this.#source ??= source;
    void this.#ensureAttached();
  }

  async waitForInitialPull(): Promise<void> {
    await this.#attaching;
  }

  async refresh(): Promise<boolean> {
    if (this.#closed) return false;
    const wasAttached = this.#attachment !== undefined;
    const attachment = await this.#ensureAttached();
    if (attachment === undefined) return false;
    if (!wasAttached) return true;
    try {
      const changed = await attachment.refresh();
      this.#warningActive = false;
      return changed;
    } catch (error) {
      this.#warn(error);
      return false;
    }
  }

  close(): void {
    this.#closed = true;
  }

  async #ensureAttached(): Promise<CloudDefinitionsAttachment | undefined> {
    if (this.#closed || this.#source === undefined) return undefined;
    if (this.#attachment) return this.#attachment;
    const attachDefinitionOverrides = this.#catalog.experimentalAttachDefinitionOverrides;
    if (attachDefinitionOverrides === undefined) {
      warnMissingCloudDefinitionsOnce();
      return undefined;
    }
    this.#attaching ??= attachDefinitionOverrides
      .call(this.#catalog, { source: this.#source })
      .then((attachment) => {
        this.#attachment = attachment;
        this.#warningActive = false;
        return attachment;
      })
      .catch((error) => {
        this.#warn(error);
        return undefined;
      })
      .finally(() => {
        this.#attaching = undefined;
      });
    return this.#attaching;
  }

  #warn(error: unknown): void {
    if (!this.#warnOnFailure || this.#warningActive) return;
    this.#warningActive = true;
    try {
      const message = error instanceof Error ? error.message : String(error);
      const activeDescriptions =
        this.#attachment === undefined
          ? "local Retrieval descriptions"
          : "last successfully applied Cloud Retrieval descriptions";
      console.warn(
        `[ratel-cloud-sdk/runtime] cloud_definitions: ${message} — ${activeDescriptions} remain active`,
      );
    } catch {
      // Console diagnostics remain fail-open.
    }
  }
}

function enableCloudDefinitions(
  runtime: RatelRuntime,
  attachment: RuntimeAttachment,
  options: AttachOptions,
): void {
  const controller = CLOUD_DEFINITION_CONTROLLERS.get(runtime);
  if (controller === undefined) return;
  controller.enable(
    createCloudDefinitionsSource({
      apiKey: options.apiKey ?? process.env.RATEL_API_KEY ?? "",
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
  );
  Object.assign(attachment, {
    refreshCloudDefinitions: () => controller.refresh(),
  });
}

/** A pre-runtime-events @ratel-ai/sdk (<0.10.0) exposes no `.events` on the runtime. */
function hasRuntimeEvents(runtime: RatelRuntime): boolean {
  try {
    const events: Partial<RatelRuntimeEvents> | undefined = runtime?.events;
    return typeof events?.subscribe === "function" && typeof events.sourceId === "string";
  } catch {
    return false;
  }
}

let warnedMissingRuntimeEvents = false;
let warnedMissingCloudDefinitions = false;

function warnMissingCloudDefinitionsOnce(): void {
  if (warnedMissingCloudDefinitions) return;
  warnedMissingCloudDefinitions = true;
  try {
    console.warn(
      "[ratel-cloud-sdk/runtime] version_skew: Cloud definitions require @ratel-ai/sdk >=0.12.0 — local Retrieval descriptions remain active",
    );
  } catch {
    // Console diagnostics remain fail-open.
  }
}

function warnMissingRuntimeEventsOnce(): void {
  if (warnedMissingRuntimeEvents) return;
  warnedMissingRuntimeEvents = true;
  try {
    console.warn(
      "[ratel-cloud-sdk/runtime] version_skew: this @ratel-ai/sdk runtime exposes no events interface (upgrade to >=0.10.0) — facts are not persisting",
    );
  } catch {
    // Console diagnostics remain fail-open.
  }
}

function toCatalogTool(tool: RatelRuntimeCatalogToolDefinition): RuntimeCatalogToolDefinition {
  return {
    id: tool.id,
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    // The core catalog has held this since 0.12.0 and we were dropping it here,
    // so Cloud indexed the agent-facing prose and every retrieval-only keyword
    // list a runtime curated was lost on the way out of the process.
    ...(typeof tool.experimentalSearchableDescription === "string"
      ? { experimentalSearchableDescription: tool.experimentalSearchableDescription }
      : {}),
    ...(isRecordOrNull(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
    ...(isRecordOrNull(tool.outputSchema) ? { outputSchema: tool.outputSchema } : {}),
    ...(isRecordOrNull(tool.metadata) ? { metadata: tool.metadata } : {}),
  };
}

function isRecordOrNull(value: unknown): value is Record<string, unknown> | null {
  return value === null || (typeof value === "object" && !Array.isArray(value));
}
