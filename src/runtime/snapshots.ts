import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from "../transport.js";
import type { RuntimeCatalogSnapshot, RuntimeCatalogToolDefinition } from "../types.js";
import { classifyDelivery, DeliveryStatus } from "./delivery-status.js";
import { hashCatalogSnapshot } from "./hash.js";
import type { RuntimeEventRejection, RuntimeEventsRetryOptions } from "./publisher.js";
import {
  createRetryConfig,
  nonNegative,
  parseRetryAfter,
  positiveInteger,
  type RetryConfig,
  requestWithRetry,
  sleep,
  withKeepAlive,
} from "./retry.js";

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60_000;
/** Cloud caches its ingest-flag decision, so a deferred snapshot retries slowly. */
const DEFERRED_RETRY_DELAY_MS = 30_000;
/** Deterministic payload rejects that will never succeed on an identical retry. */
const TERMINAL_REJECT_STATUSES = new Set([400, 413, 415]);
const CATALOG_SNAPSHOT_MAX_BYTES = 4_000_000;
const CATALOG_SNAPSHOT_MAX_TOOLS = 5_000;
const CATALOG_SNAPSHOT_MAX_ID_OR_NAME_LENGTH = 512;
const CATALOG_SNAPSHOT_MAX_DESCRIPTION_LENGTH = 16_384;
const UTF8 = new TextEncoder();

interface CatalogSnapshotToolRequest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Absent for a publisher that matches on `description`, which keeps its body byte-identical. */
  readonly searchable_description?: string;
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
  /** Maximum age of a durable confirmation before republishing. Defaults to 5 minutes. */
  readonly reconcileIntervalMs?: number;
  readonly retry?: RuntimeEventsRetryOptions;
  /** Called for tools omitted from a snapshot and terminal publication failures. */
  readonly onRejected?: (rejected: readonly RuntimeEventRejection[]) => void;
  /** Injectable timer for runtimes and deterministic tests. */
  readonly sleep?: (ms: number) => PromiseLike<void>;
  /** Shared delivery health tracker. */
  readonly deliveryStatus?: DeliveryStatus;
}

/** Fail-open publication of complete runtime catalog snapshots to Ratel Cloud. */
export class CatalogSnapshotsPublisher {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #debounceMs: number;
  readonly #reconcileIntervalMs: number;
  readonly #retry: RetryConfig;
  readonly #sleep: (ms: number) => PromiseLike<void>;
  readonly #onRejected: ((rejected: readonly RuntimeEventRejection[]) => void) | undefined;
  readonly #deliveryStatus: DeliveryStatus;
  readonly #acknowledgedHashes = new Map<string, string>();
  readonly #reconcileAt = new Map<string, number>();
  readonly #inFlightHashes = new Map<string, string>();
  readonly #latest = new Map<string, PendingCatalogSnapshot>();
  readonly #pending = new Map<string, PendingCatalogSnapshot>();
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  #draining: Promise<void> = Promise.resolve();
  #closed = false;
  #failureStreak = 0;

  constructor(options: CatalogSnapshotsPublisherOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#debounceMs = nonNegative(options.debounceMs, DEFAULT_DEBOUNCE_MS);
    this.#reconcileIntervalMs = positiveInteger(
      options.reconcileIntervalMs,
      DEFAULT_RECONCILE_INTERVAL_MS,
    );
    this.#retry = createRetryConfig(options.retry);
    this.#sleep = options.sleep ?? sleep;
    this.#onRejected = options.onRejected;
    this.#deliveryStatus = options.deliveryStatus ?? new DeliveryStatus({ warnOnFailure: false });
  }

  publish(snapshot: RuntimeCatalogSnapshot): void {
    if (this.#closed) return;
    try {
      const prepared = prepareSnapshot(snapshot);
      const sourceId = prepared.snapshot.source_id;
      if (prepared.rejected.length > 0) {
        this.#deliveryStatus.recordSnapshotPending(sourceId);
        this.#deliveryStatus.recordSnapshot(sourceId, {
          kind: "rejected_payload",
          status: null,
          message: `${prepared.rejected.length} catalog tools were rejected`,
        });
      }
      this.#surfaceRejections(prepared.rejected);
      const hash = hashCatalogSnapshot(prepared.snapshot);
      const next = {
        body: prepared.body,
        hash,
        sourceId,
      };
      this.#latest.set(sourceId, next);
      if (!this.#reconcileAt.has(sourceId)) {
        this.#reconcileAt.set(sourceId, Date.now() + this.#reconcileIntervalMs);
        this.#rescheduleReconcile();
      }
      const inFlightHash = this.#inFlightHashes.get(sourceId);
      const isDurable = hash === this.#acknowledgedHashes.get(sourceId);
      if (hash === inFlightHash || (isDurable && inFlightHash === undefined)) {
        this.#pending.delete(sourceId);
        if (this.#pending.size === 0) this.#clearFlushTimer();
        if (isDurable && inFlightHash === undefined) {
          this.#deliveryStatus.recordSnapshotSettled(sourceId);
        }
        return;
      }
      this.#deliveryStatus.recordSnapshotPending(sourceId);
      this.#pending.set(sourceId, next);
      this.#scheduleFlush();
    } catch (error) {
      const sourceId = safeSourceId(snapshot);
      this.#deliveryStatus.recordSnapshotPending(sourceId);
      this.#deliveryStatus.recordSnapshot(sourceId, {
        kind: "rejected_payload",
        status: null,
        message: `catalog snapshot cannot be prepared: ${errorMessage(error)}`,
      });
      this.#surfaceRejections([
        {
          eventId: null,
          reason: `catalog snapshot for ${sourceId} cannot be prepared: ${errorMessage(error)}`,
        },
      ]);
    }
  }

  async flush(): Promise<void> {
    await withKeepAlive(() => this.#drain());
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#clearFlushTimer();
    this.#clearReconcileTimer();
    await this.flush();
  }

  #drain(): Promise<void> {
    this.#clearFlushTimer();
    const drain = this.#draining.then(
      () => this.#drainPending(),
      () => this.#drainPending(),
    );
    this.#draining = drain;
    return drain;
  }

  async #drainPending(): Promise<void> {
    const retryPending = new Map<string, PendingCatalogSnapshot>();
    let attempted = false;
    let retryWithBackoff = false;
    let deferred = false;
    let retryAfterMs: number | undefined;
    while (this.#pending.size > 0) {
      this.#clearFlushTimer();
      const pendingSnapshots = [...this.#pending.values()];
      this.#pending.clear();
      for (const pending of pendingSnapshots) {
        const sourceId = pending.sourceId;
        attempted = true;
        retryPending.delete(sourceId);
        this.#inFlightHashes.set(sourceId, pending.hash);
        try {
          const response = await this.#send(pending.body);
          const delivery = classifyDelivery(response);
          if (response === undefined) {
            this.#deliveryStatus.recordSnapshot(sourceId, delivery);
            this.#surfaceRejections([
              {
                eventId: null,
                reason: `catalog snapshot for ${sourceId} failed after retries`,
              },
            ]);
            this.#restoreLatest(retryPending, pending);
            retryWithBackoff = true;
            continue;
          }
          const outcome = await readPublishOutcome(response);
          if (outcome === "durable") {
            const settled =
              this.#latest.get(sourceId)?.hash === pending.hash && !this.#pending.has(sourceId);
            this.#deliveryStatus.recordSnapshotDurable(sourceId, delivery, settled);
            this.#acknowledgedHashes.set(sourceId, pending.hash);
            const acknowledgedAt = Date.now();
            this.#reconcileAt.set(sourceId, acknowledgedAt + this.#reconcileIntervalMs);
            this.#rescheduleReconcile();
          } else if (outcome === "deferred") {
            this.#deliveryStatus.recordSnapshot(sourceId, delivery);
            this.#restoreLatest(retryPending, pending);
            deferred = true;
          } else if (outcome === "failed") {
            this.#deliveryStatus.recordSnapshot(sourceId, delivery);
            this.#surfaceRejections([
              {
                eventId: null,
                reason: `catalog snapshot for ${sourceId} rejected with HTTP ${response.status}`,
              },
            ]);
            if (TERMINAL_REJECT_STATUSES.has(response.status)) {
              this.#dropLatest(pending);
              continue;
            }
            this.#restoreLatest(retryPending, pending);
            retryWithBackoff = true;
            if (response.status === 429) {
              retryAfterMs = parseRetryAfter(response.headers.get("retry-after")) ?? retryAfterMs;
            }
          }
        } catch (error) {
          this.#deliveryStatus.recordSnapshot(sourceId, classifyDelivery(undefined));
          this.#surfaceRejections([
            {
              eventId: null,
              reason: `catalog snapshot for ${sourceId} failed: ${errorMessage(error)}`,
            },
          ]);
          this.#restoreLatest(retryPending, pending);
          retryWithBackoff = true;
        } finally {
          if (this.#inFlightHashes.get(sourceId) === pending.hash) {
            this.#inFlightHashes.delete(sourceId);
          }
        }
      }
    }
    if (attempted) this.#failureStreak = retryWithBackoff ? this.#failureStreak + 1 : 0;
    for (const [sourceId, pending] of retryPending) {
      if (!this.#pending.has(sourceId)) this.#pending.set(sourceId, pending);
    }
    if (this.#pending.size > 0) {
      this.#scheduleFlush(this.#retryDelayMs(retryWithBackoff, deferred, retryAfterMs));
    }
  }

  /** A deferred or failing snapshot never reschedules at the churn debounce. */
  #retryDelayMs(
    retryWithBackoff: boolean,
    deferred: boolean,
    retryAfterMs: number | undefined,
  ): number {
    if (retryWithBackoff) return retryAfterMs ?? this.#failureBackoffMs();
    if (deferred) return Math.max(DEFERRED_RETRY_DELAY_MS, this.#debounceMs);
    return this.#debounceMs;
  }

  #dropLatest(rejected: PendingCatalogSnapshot): void {
    if (this.#latest.get(rejected.sourceId)?.hash !== rejected.hash) return;
    this.#latest.delete(rejected.sourceId);
    this.#reconcileAt.delete(rejected.sourceId);
  }

  #restoreLatest(
    retryPending: Map<string, PendingCatalogSnapshot>,
    failed: PendingCatalogSnapshot,
  ): void {
    if (this.#pending.has(failed.sourceId)) return;
    const latest = this.#latest.get(failed.sourceId);
    if (latest?.hash === failed.hash) retryPending.set(failed.sourceId, latest);
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
          redirect: "manual",
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      },
      this.#retry,
      this.#sleep,
    );
  }

  #scheduleFlush(delayMs = this.#debounceMs): void {
    if (this.#closed) return;
    this.#clearFlushTimer();
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      void this.#drain();
    }, delayMs);
    this.#flushTimer.unref?.();
  }

  #scheduleReconcile(): void {
    if (this.#closed || this.#reconcileTimer !== undefined) return;
    const nextAt = Math.min(...this.#reconcileAt.values());
    if (!Number.isFinite(nextAt)) return;
    this.#reconcileTimer = setTimeout(
      () => {
        this.#reconcileTimer = undefined;
        this.#reconcile();
      },
      Math.max(0, nextAt - Date.now()),
    );
    this.#reconcileTimer.unref?.();
  }

  #reconcile(): void {
    if (this.#closed) return;
    const now = Date.now();
    for (const [sourceId, latest] of this.#latest) {
      if ((this.#reconcileAt.get(sourceId) ?? Number.POSITIVE_INFINITY) > now) continue;
      this.#reconcileAt.set(sourceId, now + this.#reconcileIntervalMs);
      if (this.#inFlightHashes.get(sourceId) === latest.hash || this.#pending.has(sourceId))
        continue;
      this.#pending.set(sourceId, latest);
    }
    if (this.#pending.size > 0) void this.#drain();
    this.#scheduleReconcile();
  }

  #rescheduleReconcile(): void {
    this.#clearReconcileTimer();
    this.#scheduleReconcile();
  }

  /** Continues the in-request exponential curve across cycles, capped at maxBackoffMs. */
  #failureBackoffMs(): number {
    const base = Math.min(
      this.#retry.initialBackoffMs * 2 ** (this.#retry.maxAttempts - 1),
      this.#retry.maxBackoffMs,
    );
    const growth = 2 ** Math.min(Math.max(this.#failureStreak - 1, 0), 30);
    return Math.max(this.#debounceMs, Math.min(base * growth, this.#retry.maxBackoffMs));
  }

  #clearFlushTimer(): void {
    if (this.#flushTimer === undefined) return;
    clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
  }

  #clearReconcileTimer(): void {
    if (this.#reconcileTimer === undefined) return;
    clearTimeout(this.#reconcileTimer);
    this.#reconcileTimer = undefined;
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

/** Trims and truncates a source id exactly like snapshot payload normalization. */
export function normalizeSourceId(value: string): string {
  return normalizeText(value, CATALOG_SNAPSHOT_MAX_ID_OR_NAME_LENGTH);
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
    ...normalizedSearchableDescription(tool),
    inputSchema: tool.inputSchema ?? null,
    outputSchema: tool.outputSchema ?? null,
    metadata: tool.metadata ?? null,
  };
}

/**
 * Kept out of the object entirely when unset or empty after trimming. An
 * always-present key would change the canonical body, and therefore the ETag,
 * for every publisher that never adopted the field.
 */
function normalizedSearchableDescription(tool: RuntimeCatalogToolDefinition): {
  experimentalSearchableDescription?: string;
} {
  if (typeof tool.experimentalSearchableDescription !== "string") return {};
  const normalized = normalizeText(
    tool.experimentalSearchableDescription,
    CATALOG_SNAPSHOT_MAX_DESCRIPTION_LENGTH,
  );
  return normalized ? { experimentalSearchableDescription: normalized } : {};
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
    ...(tool.experimentalSearchableDescription === undefined
      ? {}
      : { searchable_description: tool.experimentalSearchableDescription }),
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
