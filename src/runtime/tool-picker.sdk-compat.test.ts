import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `tool-picker.ts` loads `RetrieverError` from `@ratel-ai/sdk` on the first
 * pick, so `/runtime` keeps loading next to SDKs that predate it. These cases
 * stand in for such SDKs; the picker must then fail plainly, before any request.
 */

const TOOLS = [{ id: "deploy", kind: "tool" as const, text: "deploy" }];

async function loadPicker(fetchImpl: typeof fetch) {
  vi.resetModules();
  const { ratelCloud } = await import("./tool-picker.js");
  return ratelCloud({ apiKey: "rk", fetch: fetchImpl }).toolPicker;
}

afterEach(() => {
  vi.doUnmock("@ratel-ai/sdk");
});

describe("toolPicker next to an SDK without RetrieverError", () => {
  it("fails with a plain Error naming RetrieverError when the SDK lacks it", async () => {
    vi.doMock("@ratel-ai/sdk", () => ({}));
    const fetchImpl = vi.fn<typeof fetch>();
    const picker = await loadPicker(fetchImpl);

    const error = await Promise.resolve(picker("q", TOOLS, 5)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("Error");
    expect((error as Error).message).toContain("RetrieverError");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails with a plain Error naming the SDK when it cannot be imported", async () => {
    vi.doMock("@ratel-ai/sdk", () => {
      throw new Error("Cannot find package '@ratel-ai/sdk'");
    });
    const fetchImpl = vi.fn<typeof fetch>();
    const picker = await loadPicker(fetchImpl);

    const error = await Promise.resolve(picker("q", TOOLS, 5)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("@ratel-ai/sdk");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
