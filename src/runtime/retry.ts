const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export interface RetryOptions {
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
}

export interface RetryConfig {
  readonly maxAttempts: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly random: () => number;
}

export async function requestWithRetry(
  request: () => Promise<Response>,
  retry: RetryConfig,
  sleep: (ms: number) => PromiseLike<void>,
): Promise<Response | undefined> {
  let response: Response | undefined;
  for (let attempt = 0; attempt < retry.maxAttempts; attempt += 1) {
    let retryAfterMs: number | undefined;
    try {
      response = await request();
      if (response.ok || !isRetryableStatus(response.status)) return response;
      retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    } catch {
      // Network and timeout failures are retryable; exhaustion remains fail-open.
    }
    if (attempt + 1 < retry.maxAttempts) {
      const cappedDelay = Math.min(
        retryAfterMs ?? retry.initialBackoffMs * 2 ** attempt,
        retry.maxBackoffMs,
      );
      const delay =
        retryAfterMs === undefined ? fullJitter(cappedDelay, retry.random) : cappedDelay;
      try {
        await sleep(delay);
      } catch {
        // An injected timer cannot make delivery fail closed.
      }
    }
  }
  return response;
}

export function createRetryConfig(options: RetryOptions | undefined): RetryConfig {
  return {
    maxAttempts: positiveInteger(options?.maxAttempts, DEFAULT_MAX_ATTEMPTS),
    initialBackoffMs: nonNegative(options?.initialBackoffMs, DEFAULT_INITIAL_BACKOFF_MS),
    maxBackoffMs: nonNegative(options?.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS),
    random: options?.random ?? Math.random,
  };
}

export function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

export function nonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? -1) >= 0 ? (value as number) : fallback;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function fullJitter(delayMs: number, random: () => number): number {
  const sample = random();
  const ratio = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1) : 0;
  return delayMs * ratio;
}

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}
