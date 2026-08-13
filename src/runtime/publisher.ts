import { randomBytes } from "node:crypto";
import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from "../transport.js";
import type { RuntimeEvent } from "../types.js";
import {
  createRetryConfig,
  nonNegative,
  positiveInteger,
  type RetryConfig,
  requestWithRetry,
  sleep,
} from "./retry.js";

export const RUNTIME_EVENT_BATCH_MAX_EVENTS = 5_000;
export const RUNTIME_EVENT_BATCH_MAX_BYTES = 4 * 1_024 * 1_024;
export const RUNTIME_EVENT_MAX_BYTES = 64 * 1_024;

const DEFAULT_FLUSH_INTERVAL_MS = 1_000;

const BATCH_PREFIX = '{"events":[';
const BATCH_SUFFIX = "]}";
const UTF8 = new TextEncoder();

interface SerializedBatch {
  readonly body: string;
}

interface BatchBuildResult {
  readonly batches: SerializedBatch[];
  readonly rejected: RuntimeEventRejection[];
}

interface DropWindow {
  count: number;
  startTs: number;
  endTs: number;
  sessionId: string;
  sourceId: string;
}

export interface RuntimeEventRejection {
  readonly eventId: string | null;
  readonly reason: string;
}

export interface RuntimeEventsRetryOptions {
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface RuntimeEventsPublisherOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Maximum events held before the oldest is dropped. Defaults to 1,024. */
  queueCapacity?: number;
  /** Delay before queued events drain automatically. Defaults to 1 second. */
  flushIntervalMs?: number;
  /** Called for terminal per-event rejects returned by Cloud. */
  onRejected?: (rejected: readonly RuntimeEventRejection[]) => void;
  retry?: RuntimeEventsRetryOptions;
  /** Injectable timer for runtimes and deterministic tests. */
  sleep?: (ms: number) => PromiseLike<void>;
}

/** Fail-open, in-memory delivery of runtime event envelopes to Ratel Cloud. */
export class RuntimeEventsPublisher {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #onRejected: ((rejected: readonly RuntimeEventRejection[]) => void) | undefined;
  readonly #retry: RetryConfig;
  readonly #sleep: (ms: number) => PromiseLike<void>;
  readonly #enabled: boolean;
  readonly #queueCapacity: number;
  readonly #flushIntervalMs: number;
  readonly #queue: RuntimeEvent[] = [];
  readonly #dropWindows = new Map<string, Map<string, DropWindow>>();
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #draining: Promise<void> = Promise.resolve();

  constructor(options: RuntimeEventsPublisherOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#onRejected = options.onRejected;
    this.#retry = createRetryConfig(options.retry);
    this.#sleep = options.sleep ?? sleep;
    this.#enabled = process.env.RATEL_CLOUD_EVENTS?.trim().toLowerCase() !== "off";
    this.#queueCapacity = positiveInteger(options.queueCapacity, 1_024);
    this.#flushIntervalMs = nonNegative(options.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS);
  }

  publish(event: RuntimeEvent): void {
    if (!this.#enabled) return;
    try {
      if (this.#queue.length === this.#queueCapacity) {
        const dropped = this.#queue.shift();
        if (dropped) this.#recordDrop(dropped);
      }
      this.#queue.push(event);
      this.#scheduleFlush();
    } catch {
      // Malformed caller objects must not escape into the agent operation.
    }
  }

  async flush(): Promise<void> {
    this.#clearFlushTimer();
    const drain = this.#draining.then(
      () => this.#drainQueued(),
      () => this.#drainQueued(),
    );
    this.#draining = drain;
    await drain;
  }

  async #drainQueued(): Promise<void> {
    try {
      const events = this.#queue.splice(0);
      const dropWindows = [...this.#dropWindows.values()].flatMap((bySession) => [
        ...bySession.values(),
      ]);
      this.#dropWindows.clear();
      events.push(...dropWindows.map(droppedEvent));
      const built = createBatches(events);
      this.#surfaceRejections(built.rejected);
      for (const batch of built.batches) {
        await this.#sendBatch(batch);
      }
    } catch {
      // Serialization and runtime failures are terminal but always fail-open.
    }
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== undefined) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      void this.flush();
    }, this.#flushIntervalMs);
    this.#flushTimer.unref?.();
  }

  #clearFlushTimer(): void {
    if (this.#flushTimer === undefined) return;
    clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
  }

  async #sendBatch(batch: SerializedBatch): Promise<void> {
    const response = await requestWithRetry(
      () =>
        this.#fetch(`${this.#baseUrl}/events`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            "content-type": "application/json",
          },
          body: batch.body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        }),
      this.#retry,
      this.#sleep,
    );
    if (response?.ok) this.#surfaceRejections(await readRejections(response));
  }

  #surfaceRejections(rejected: readonly RuntimeEventRejection[]): void {
    if (rejected.length === 0) return;
    try {
      this.#onRejected?.(rejected);
    } catch {
      // User-provided observability callbacks are fail-open too.
    }
  }

  #recordDrop(event: RuntimeEvent): void {
    const timestamp = Number.isFinite(event.ts) ? event.ts : Date.now();
    let bySession = this.#dropWindows.get(event.source_id);
    if (bySession === undefined) {
      bySession = new Map();
      this.#dropWindows.set(event.source_id, bySession);
    }
    const dropWindow = bySession.get(event.session_id);
    if (dropWindow) {
      dropWindow.count += 1;
      dropWindow.endTs = timestamp;
      return;
    }
    bySession.set(event.session_id, {
      count: 1,
      startTs: timestamp,
      endTs: timestamp,
      sessionId: event.session_id,
      sourceId: event.source_id,
    });
  }
}

function createBatches(events: RuntimeEvent[]): BatchBuildResult {
  const batches: SerializedBatch[] = [];
  const rejected: RuntimeEventRejection[] = [];
  let current: RuntimeEvent[] = [];
  let serialized: string[] = [];
  let bytes = byteLength(BATCH_PREFIX) + byteLength(BATCH_SUFFIX);

  const finish = (): void => {
    if (current.length === 0) return;
    batches.push({ body: BATCH_PREFIX + serialized.join(",") + BATCH_SUFFIX });
    current = [];
    serialized = [];
    bytes = byteLength(BATCH_PREFIX) + byteLength(BATCH_SUFFIX);
  };

  for (const event of events) {
    let json: string | undefined;
    try {
      json = JSON.stringify(event);
    } catch {
      rejected.push({ eventId: safeEventId(event), reason: "event cannot be serialized" });
      continue;
    }
    if (json === undefined) {
      rejected.push({ eventId: safeEventId(event), reason: "event cannot be serialized" });
      continue;
    }
    const eventBytes = byteLength(json);
    if (eventBytes > RUNTIME_EVENT_MAX_BYTES) {
      rejected.push({
        eventId: safeEventId(event),
        reason: `serialized event exceeds ${RUNTIME_EVENT_MAX_BYTES} bytes`,
      });
      continue;
    }
    const addition = eventBytes + (current.length > 0 ? 1 : 0);
    if (
      current.length === RUNTIME_EVENT_BATCH_MAX_EVENTS ||
      (current.length > 0 && bytes + addition > RUNTIME_EVENT_BATCH_MAX_BYTES)
    ) {
      finish();
    }
    current.push(event);
    serialized.push(json);
    bytes += eventBytes + (current.length > 1 ? 1 : 0);
  }
  finish();
  return { batches, rejected };
}

function byteLength(value: string): number {
  return UTF8.encode(value).byteLength;
}

function safeEventId(event: RuntimeEvent): string | null {
  try {
    return typeof event.event_id === "string" ? event.event_id : null;
  } catch {
    return null;
  }
}

async function readRejections(response: Response): Promise<RuntimeEventRejection[]> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return [];
  }
  if (!isRecord(body) || !Array.isArray(body.rejected)) return [];
  return body.rejected
    .filter(
      (item): item is Record<string, unknown> => isRecord(item) && typeof item.reason === "string",
    )
    .map((item) => ({
      eventId: typeof item.event_id === "string" ? item.event_id : null,
      reason: item.reason as string,
    }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function droppedEvent(window: DropWindow): RuntimeEvent {
  return {
    v: 2,
    event_id: newRuntimeEventId(),
    ts: Date.now(),
    session_id: window.sessionId,
    source_id: window.sourceId,
    type: "events_dropped",
    dropped_count: window.count,
    reason: "queue_overflow",
    window_start_ts: window.startTs,
    window_end_ts: window.endTs,
  };
}

function newRuntimeEventId(now = Date.now()): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let remaining = now;
  let encodedTime = "";
  for (let index = 0; index < 10; index += 1) {
    encodedTime = alphabet[remaining % 32] + encodedTime;
    remaining = Math.floor(remaining / 32);
  }
  const entropy = randomBytes(10);
  let buffer = 0;
  let bits = 0;
  let encodedEntropy = "";
  for (const byte of entropy) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encodedEntropy += alphabet[(buffer >> bits) & 31];
    }
  }
  return encodedTime + encodedEntropy;
}
