import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from "../transport.js";
import type { RuntimeCatalogSnapshot, RuntimeCatalogToolDefinition } from "../types.js";
import { hashCatalogSnapshot } from "./hash.js";
import type { RuntimeEventRejection, RuntimeEventsRetryOptions } from "./publisher.js";
import {
  createRetryConfig,
  nonNegative,
  type RetryConfig,
  requestWithRetry,
  sleep,
} from "./retry.js";

const DEFAULT_DEBOUNCE_MS = 500;
const CATALOG_SNAPSHOT_MAX_BYTES = 4_000_000;
const CATALOG_SNAPSHOT_MAX_TOOLS = 5_000;
const CATALOG_SNAPSHOT_MAX_ID_OR_NAME_LENGTH = 512;
const CATALOG_SNAPSHOT_MAX_DESCRIPTION_LENGTH = 16_384;
const UTF8 = new TextEncoder();

interface CatalogSnapshotToolRequest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown> | null;
  readonly output_schema: Record<string, unknown> | null;
  readonly metadata: Record<string, unknown> | null;
}

interface PendingCatalogSnapshot {
  readonly body: string;
  readonly hash: string;
  readonly sourceId: string;
}

interface PreparedCatalogSnapshot {
  readonly body: string;
  readonly snapshot: RuntimeCatalogSnapshot;
  readonly rejected: RuntimeEventRejection[];
}

type SnapshotPublishOutcome = "durable" | "deferred" | "failed";

export interface CatalogSnapshotsPublisherOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Quiet period after catalog churn before publishing. Defaults to 500 ms. */
  readonly debounceMs?: number;
  readonly retry?: RuntimeEventsRetryOptions;
  /** Called for tools omitted from a snapshot and terminal publication failures. */
  readonly onRejected?: (rejected: readonly RuntimeEventRejection[]) => void;
  /** Injectable timer for runtimes and deterministic tests. */
  readonly sleep?: (ms: number) => PromiseLike<void>;
}

/** Fail-open publication of complete runtime catalog snapshots to Ratel Cloud. */
export class CatalogSnapshotsPublisher {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #debounceMs: number;
  readonly #retry: RetryConfig;
  readonly #sleep: (ms: number) => PromiseLike<void>;
  readonly #onRejected: ((rejected: readonly RuntimeEventRejection[]) => void) | undefined;
  readonly #acknowledgedHashes = new Map<string, string>();
  readonly #inFlightHashes = new Map<string, string>();
  readonly #pending = new Map<string, PendingCatalogSnapshot>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #draining: Promise<void> = Promise.resolve();

  constructor(options: CatalogSnapshotsPublisherOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#debounceMs = nonNegative(options.debounceMs, DEFAULT_DEBOUNCE_MS);
    this.#retry = createRetryConfig(options.retry);
    this.#sleep = options.sleep ?? sleep;
    this.#onRejected = options.onRejected;
  }

  publish(snapshot: RuntimeCatalogSnapshot): void {
    try {
      const prepared = prepareSnapshot(snapshot);
      this.#surfaceRejections(prepared.rejected);
      const hash = hashCatalogSnapshot(prepared.snapshot);
      const sourceId = prepared.snapshot.source_id;
      const inFlightHash = this.#inFlightHashes.get(sourceId);
      if (
        hash === inFlightHash ||
        (hash === this.#acknowledgedHashes.get(sourceId) && inFlightHash === undefined)
      ) {
        this.#pending.delete(sourceId);
        if (this.#pending.size === 0) this.#clearTimer();
        return;
      }
      this.#pending.set(sourceId, {
        body: prepared.body,
        hash,
        sourceId,
      });
      this.#scheduleFlush();
    } catch (error) {
      this.#surfaceRejections([
        {
          eventId: null,
          reason: `catalog snapshot for ${safeSourceId(snapshot)} cannot be prepared: ${errorMessage(error)}`,
        },
      ]);
    }
  }

  async flush(): Promise<void> {
    this.#clearTimer();
    const drain = this.#draining.then(
      () => this.#drainPending(),
      () => this.#drainPending(),
    );
    this.#draining = drain;
    await drain;
  }

  async #drainPending(): Promise<void> {
    const deferred = new Map<string, PendingCatalogSnapshot>();
    while (this.#pending.size > 0) {
      this.#clearTimer();
      const pendingSnapshots = [...this.#pending.values()];
      this.#pending.clear();
      for (const pending of pendingSnapshots) {
        const sourceId = pending.sourceId;
        deferred.delete(sourceId);
        this.#inFlightHashes.set(sourceId, pending.hash);
        try {
          const response = await this.#send(pending.body);
          if (response === undefined) {
            this.#surfaceRejections([
              {
                eventId: null,
                reason: `catalog snapshot for ${sourceId} failed after retries`,
              },
            ]);
            continue;
          }
          const outcome = await readPublishOutcome(response);
          if (outcome === "durable") {
            this.#acknowledgedHashes.set(sourceId, pending.hash);
          } else if (outcome === "deferred" && !this.#pending.has(sourceId)) {
            deferred.set(sourceId, pending);
          } else if (outcome === "failed") {
            this.#surfaceRejections([
              {
                eventId: null,
                reason: `catalog snapshot for ${sourceId} rejected with HTTP ${response.status}`,
              },
            ]);
          }
        } catch (error) {
          this.#surfaceRejections([
            {
              eventId: null,
              reason: `catalog snapshot for ${sourceId} failed: ${errorMessage(error)}`,
            },
          ]);
        } finally {
          if (this.#inFlightHashes.get(sourceId) === pending.hash) {
            this.#inFlightHashes.delete(sourceId);
          }
        }
      }
    }
    for (const [sourceId, pending] of deferred) {
      this.#pending.set(sourceId, pending);
    }
    if (deferred.size > 0) this.#scheduleFlush();
  }

  async #send(body: string): Promise<Response | undefined> {
    return requestWithRetry(
      () => {
        const headers: Record<string, string> = {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        };
        return this.#fetch(`${this.#baseUrl}/catalog/snapshot`, {
          method: "PUT",
          headers,
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      },
      this.#retry,
      this.#sleep,
    );
  }

  #scheduleFlush(): void {
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, this.#debounceMs);
    this.#timer.unref?.();
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #surfaceRejections(rejected: readonly RuntimeEventRejection[]): void {
    if (rejected.length === 0) return;
    try {
      this.#onRejected?.(rejected);
    } catch {
      // User-provided observability callbacks remain fail-open.
    }
  }
}

function prepareSnapshot(snapshot: RuntimeCatalogSnapshot): PreparedCatalogSnapshot {
  const rejected: RuntimeEventRejection[] = [];
  const sourceId = normalizeText(snapshot.source_id, CATALOG_SNAPSHOT_MAX_ID_OR_NAME_LENGTH);
  const prefix = `{"source_id":${JSON.stringify(sourceId)},"tools":[`;
  const suffix = "]}";
  const tools: RuntimeCatalogToolDefinition[] = [];
  const serializedTools: string[] = [];
  const seenToolIds = new Set<string>();
  let bytes = byteLength(prefix) + byteLength(suffix);

  for (const candidate of snapshot.tools) {
    if (tools.length === CATALOG_SNAPSHOT_MAX_TOOLS) {
      rejected.push({
        eventId: safeToolId(candidate),
        reason: `catalog snapshot tool limit is ${CATALOG_SNAPSHOT_MAX_TOOLS}`,
      });
      continue;
    }
    let tool: RuntimeCatalogToolDefinition;
    let requestTool: CatalogSnapshotToolRequest;
    let serialized: string;
    try {
      tool = normalizeTool(candidate);
      if (tool.name === "") {
        rejected.push({
          eventId: safeToolId(candidate),
          reason: "catalog snapshot tool name is empty",
        });
        continue;
      }
      if (seenToolIds.has(tool.id)) {
        rejected.push({
          eventId: safeToolId(candidate),
          reason: `catalog snapshot tool id is duplicated after normalization: ${tool.id}`,
        });
        continue;
      }
      requestTool = toToolRequest(tool);
      serialized = JSON.stringify(requestTool);
    } catch {
      rejected.push({
        eventId: safeToolId(candidate),
        reason: "catalog snapshot tool cannot be serialized",
      });
      continue;
    }
    const addition = byteLength(serialized) + (tools.length > 0 ? 1 : 0);
    if (bytes + addition > CATALOG_SNAPSHOT_MAX_BYTES) {
      rejected.push({
        eventId: safeToolId(candidate),
        reason: `catalog snapshot tool cannot fit within ${CATALOG_SNAPSHOT_MAX_BYTES} bytes`,
      });
      continue;
    }
    tools.push(tool);
    serializedTools.push(serialized);
    seenToolIds.add(tool.id);
    bytes += addition;
  }
  return {
    body: prefix + serializedTools.join(",") + suffix,
    snapshot: { source_id: sourceId, tools },
    rejected,
  };
}

function normalizeTool(tool: RuntimeCatalogToolDefinition): RuntimeCatalogToolDefinition {
  const name = normalizeText(tool.name, CATALOG_SNAPSHOT_MAX_ID_OR_NAME_LENGTH);
  return {
    id: normalizeText(tool.id, CATALOG_SNAPSHOT_MAX_ID_OR_NAME_LENGTH) || name,
    name,
    description: normalizeText(tool.description ?? "", CATALOG_SNAPSHOT_MAX_DESCRIPTION_LENGTH),
    inputSchema: tool.inputSchema ?? null,
    outputSchema: tool.outputSchema ?? null,
    metadata: tool.metadata ?? null,
  };
}

function normalizeText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

function safeToolId(tool: RuntimeCatalogToolDefinition): string | null {
  try {
    return typeof tool.id === "string" ? tool.id : null;
  } catch {
    return null;
  }
}

function safeSourceId(snapshot: RuntimeCatalogSnapshot): string {
  try {
    return typeof snapshot.source_id === "string" ? snapshot.source_id : "unknown source";
  } catch {
    return "unknown source";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toToolRequest(tool: RuntimeCatalogToolDefinition): CatalogSnapshotToolRequest {
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.inputSchema ?? null,
    output_schema: tool.outputSchema ?? null,
    metadata: tool.metadata ?? null,
  };
}

function byteLength(value: string): number {
  return UTF8.encode(value).byteLength;
}

async function readPublishOutcome(response: Response): Promise<SnapshotPublishOutcome> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (isRecord(body) && body.synced === false) return "deferred";
  return response.status === 200 ? "durable" : "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
