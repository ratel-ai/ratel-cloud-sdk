import { afterEach, describe, expect, it, vi } from "vitest";
import { sleep } from "./retry.js";

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
