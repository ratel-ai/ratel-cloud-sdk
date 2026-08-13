import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from "../transport.js";
import type { RuntimeCatalogSnapshot, RuntimeCatalogToolDefinition } from "../types.js";
import { hashCatalogSnapshot } from "./hash.js";
import type { RuntimeEventsRetryOptions } from "./publisher.js";

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

interface CatalogSnapshotRequest {
  readonly source_id: string;
  readonly tools: readonly CatalogSnapshotToolRequest[];
}

interface CatalogSnapshotToolRequest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown> | null;
  readonly output_schema: Record<string, unknown> | null;
  readonly metadata: Record<string, unknown> | null;
}

interface PendingCatalogSnapshot {
  readonly hash: string;
  readonly request: CatalogSnapshotRequest;
}

export interface CatalogSnapshotsPublisherOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Quiet period after catalog churn before publishing. Defaults to 500 ms. */
  readonly debounceMs?: number;
  readonly retry?: RuntimeEventsRetryOptions;
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
  readonly #maxAttempts: number;
  readonly #initialBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #sleep: (ms: number) => PromiseLike<void>;
  readonly #publishedHashes = new Map<string, string>();
  readonly #etags = new Map<string, string>();
  #pending: PendingCatalogSnapshot | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #draining: Promise<void> = Promise.resolve();

  constructor(options: CatalogSnapshotsPublisherOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#debounceMs = nonNegative(options.debounceMs, DEFAULT_DEBOUNCE_MS);
    this.#maxAttempts = positiveInteger(options.retry?.maxAttempts, DEFAULT_MAX_ATTEMPTS);
    this.#initialBackoffMs = nonNegative(
      options.retry?.initialBackoffMs,
      DEFAULT_INITIAL_BACKOFF_MS,
    );
    this.#maxBackoffMs = nonNegative(options.retry?.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS);
    this.#sleep = options.sleep ?? sleep;
  }

  publish(snapshot: RuntimeCatalogSnapshot): void {
    try {
      const hash = hashCatalogSnapshot(snapshot);
      if (hash === this.#publishedHashes.get(snapshot.source_id)) {
        this.#pending = undefined;
        this.#clearTimer();
        return;
      }
      this.#pending = { hash, request: toRequest(snapshot) };
      this.#scheduleFlush();
    } catch {
      // Malformed definitions cannot escape into the agent operation.
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
    const pending = this.#pending;
    this.#pending = undefined;
    if (!pending) return;
    try {
      const sourceId = pending.request.source_id;
      if (pending.hash === this.#publishedHashes.get(sourceId)) return;
      const response = await this.#send(pending.request, this.#etags.get(sourceId));
      if (response.ok) {
        this.#publishedHashes.set(sourceId, pending.hash);
        this.#etags.set(sourceId, response.headers.get("etag") ?? `"${pending.hash}"`);
      }
    } catch {
      // Snapshot publication is always fail-open.
    }
  }

  async #send(request: CatalogSnapshotRequest, etag: string | undefined): Promise<Response> {
    let response: Response | undefined;
    for (let attempt = 0; attempt < this.#maxAttempts; attempt += 1) {
      let retryAfterMs: number | undefined;
      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        };
        if (etag) headers["if-match"] = etag;
        response = await this.#fetch(`${this.#baseUrl}/catalog/snapshot`, {
          method: "PUT",
          headers,
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        if (response.ok || !isRetryableStatus(response.status)) return response;
        retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      } catch {
        // Network and timeout failures are retryable.
      }
      if (attempt + 1 < this.#maxAttempts) {
        const delay =
          retryAfterMs ?? Math.min(this.#initialBackoffMs * 2 ** attempt, this.#maxBackoffMs);
        try {
          await this.#sleep(delay);
        } catch {
          // An injected timer cannot make delivery fail closed.
        }
      }
    }
    return response ?? Response.error();
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
}

function toRequest(snapshot: RuntimeCatalogSnapshot): CatalogSnapshotRequest {
  return {
    source_id: snapshot.source_id,
    tools: snapshot.tools.map(toToolRequest),
  };
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

function nonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? -1) >= 0 ? (value as number) : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
