import type { RuntimeCatalogToolDefinition, RuntimeEvent } from "../types.js";
import { RuntimeEventsPublisher, type RuntimeEventsPublisherOptions } from "./publisher.js";
import { CatalogSnapshotsPublisher } from "./snapshots.js";

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

export interface AttachOptions extends Omit<RuntimeEventsPublisherOptions, "apiKey"> {
  /** Project API key. Defaults to `RATEL_API_KEY`. */
  readonly apiKey?: string;
  /** Stable deployment source. Defaults to the Ratel runtime's OTel-derived source id. */
  readonly sourceId?: string;
  /** Quiet period after catalog churn before publication. Defaults to 500 ms. */
  readonly snapshotDebounceMs?: number;
}

export interface RuntimeAttachment {
  /** Deliver runtime work already accepted by this process. */
  flush(): Promise<void>;
  /** Stop accepting runtime work and deliver everything already accepted. */
  close(): Promise<void>;
}

const ATTACHMENTS = new WeakMap<object, RuntimeAttachment>();
const NOOP_ATTACHMENT: RuntimeAttachment = {
  flush: async () => {},
  close: async () => {},
};
let missingApiKeyWarned = false;

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
    sourceId = runtime.events.sourceId,
    snapshotDebounceMs,
    ...delivery
  } = options;
  warnIfMissingApiKey(apiKey);
  const publisher = new RuntimeEventsPublisher({ ...delivery, apiKey });
  const snapshots = new CatalogSnapshotsPublisher({
    apiKey,
    ...(delivery.baseUrl === undefined ? {} : { baseUrl: delivery.baseUrl }),
    ...(delivery.fetch === undefined ? {} : { fetch: delivery.fetch }),
    ...(delivery.timeoutMs === undefined ? {} : { timeoutMs: delivery.timeoutMs }),
    ...(snapshotDebounceMs === undefined ? {} : { debounceMs: snapshotDebounceMs }),
    ...(delivery.retry === undefined ? {} : { retry: delivery.retry }),
    ...(delivery.sleep === undefined ? {} : { sleep: delivery.sleep }),
  });
  const publishSnapshot = (): void => {
    try {
      const snapshot = runtime.catalog.snapshot();
      snapshots.publish({
        source_id: sourceId,
        tools: snapshot.tools.map(toCatalogTool),
        ...(snapshot.skills === undefined ? {} : { skills: snapshot.skills }),
      });
    } catch {
      // Snapshot observation is optional and must never affect the host operation.
    }
  };
  const subscription = runtime.events.subscribe((batch) => {
    for (const event of batch) {
      publisher.publish(event.source_id === sourceId ? event : { ...event, source_id: sourceId });
    }
    if (batch.some((event) => event.type === "index_churn" || event.type === "skill_churn")) {
      publishSnapshot();
    }
  });
  publishSnapshot();

  let closePromise: Promise<void> | undefined;
  const flush = async (): Promise<void> => {
    try {
      await subscription.flush();
    } catch {
      // SDK delivery is observational and must not make host shutdown fail.
    }
    try {
      await Promise.all([publisher.flush(), snapshots.flush()]);
    } catch {
      // Publisher lifecycle is fail-open too.
    }
  };
  const handle: RuntimeAttachment = {
    flush,
    close: () => {
      closePromise ??= (async () => {
        try {
          subscription.unsubscribe();
        } catch {
          // Detach failures cannot escape into host shutdown.
        }
        ATTACHMENTS.delete(runtime);
        await flush();
      })();
      return closePromise;
    },
  };
  ATTACHMENTS.set(runtime, handle);
  return handle;
}

function warnIfMissingApiKey(apiKey: string): void {
  if (missingApiKeyWarned || apiKey.trim() !== "") return;
  missingApiKeyWarned = true;
  try {
    console.warn(
      "[ratel-cloud-sdk/runtime] RATEL_API_KEY is missing; runtime delivery will fail authentication.",
    );
  } catch {
    // Diagnostics remain fail-open too.
  }
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
