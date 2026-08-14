import { afterEach, describe, expect, it, vi } from "vitest";
import { createRetryConfig, requestWithRetry, sleep } from "./retry.js";

describe("requestWithRetry", () => {
  it("returns redirects without retrying", async () => {
    const request = vi.fn(async () => new Response(null, { status: 302 }));

    const response = await requestWithRetry(
      request,
      createRetryConfig({ maxAttempts: 3 }),
      async () => {},
    );

    expect(response?.status).toBe(302);
    expect(request).toHaveBeenCalledOnce();
  });

  it("applies injected full jitter after clamping exponential backoff", async () => {
    const sleeps: number[] = [];
    const random = vi.fn(() => 0.5);
    const retry = createRetryConfig({
      maxAttempts: 3,
      initialBackoffMs: 100,
      maxBackoffMs: 150,
      random,
    });

    await requestWithRetry(
      async () => {
        throw new Error("offline");
      },
      retry,
      async (ms) => {
        sleeps.push(ms);
      },
    );

    expect(sleeps).toEqual([50, 75]);
    expect(random).toHaveBeenCalledTimes(2);
  });
});

describe("retry sleep", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not keep Node alive while waiting", async () => {
    const unref = vi.fn();
    vi.spyOn(globalThis, "setTimeout").mockImplementationOnce(((callback: () => void) => {
      queueMicrotask(callback);
      return { unref };
    }) as unknown as typeof setTimeout);

    await sleep(60_000);

    expect(unref).toHaveBeenCalledOnce();
  });
});
