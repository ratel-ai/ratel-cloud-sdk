import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from "../transport.js";
import type { RuntimeCatalogSnapshot, RuntimeCatalogToolDefinition } from "../types.js";
import { hashCatalogSnapshot } from "./hash.js";
import type { RuntimeEventsRetryOptions } from "./publisher.js";
import {
  createRetryConfig,
  nonNegative,
  type RetryConfig,
  requestWithRetry,
  sleep,
} from "./retry.js";

const DEFAULT_DEBOUNCE_MS = 500;

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
  readonly #retry: RetryConfig;
  readonly #sleep: (ms: number) => PromiseLike<void>;
  readonly #publishedHashes = new Map<string, string>();
  readonly #etags = new Map<string, string>();
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
  }

  publish(snapshot: RuntimeCatalogSnapshot): void {
    try {
      const hash = hashCatalogSnapshot(snapshot);
      if (hash === this.#publishedHashes.get(snapshot.source_id)) {
        this.#pending.delete(snapshot.source_id);
        if (this.#pending.size === 0) this.#clearTimer();
        return;
      }
      this.#pending.set(snapshot.source_id, { hash, request: toRequest(snapshot) });
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
    const pendingSnapshots = [...this.#pending.values()];
    this.#pending.clear();
    for (const pending of pendingSnapshots) {
      try {
        const sourceId = pending.request.source_id;
        if (pending.hash === this.#publishedHashes.get(sourceId)) continue;
        const etag = this.#etags.get(sourceId);
        let response = await this.#send(pending.request, etag);
        if (etag !== undefined && response.status === 412) {
          this.#etags.delete(sourceId);
          response = await this.#send(pending.request, undefined);
        }
        if (response.ok) {
          this.#publishedHashes.set(sourceId, pending.hash);
          this.#etags.set(sourceId, response.headers.get("etag") ?? `"${pending.hash}"`);
        }
      } catch {
        // Snapshot publication is always fail-open.
      }
    }
  }

  async #send(request: CatalogSnapshotRequest, etag: string | undefined): Promise<Response> {
    return (
      (await requestWithRetry(
        () => {
          const headers: Record<string, string> = {
            authorization: `Bearer ${this.#apiKey}`,
            "content-type": "application/json",
          };
          if (etag) headers["if-match"] = etag;
          return this.#fetch(`${this.#baseUrl}/catalog/snapshot`, {
            method: "PUT",
            headers,
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(this.#timeoutMs),
          });
        },
        this.#retry,
        this.#sleep,
      )) ?? Response.error()
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
