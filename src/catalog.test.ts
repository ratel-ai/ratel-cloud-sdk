import { describe, expect, it } from "vitest";
import { RatelCloudSdk } from "./index.js";
import { MockCloud } from "./testing/mock-cloud.js";
import type { WireSkill } from "./types.js";

function wireSkill(overrides: Partial<WireSkill> & { id: string; name: string }): WireSkill {
  return { description: "d", tags: [], tools: [], metadata: {}, body: "b", ...overrides };
}

function makeSdk(mock: MockCloud): RatelCloudSdk {
  return new RatelCloudSdk({
    apiKey: mock.apiKey,
    baseUrl: "https://mock.test/api/v1",
    fetch: mock.fetch,
  });
}

describe("CatalogClient.pull", () => {
  const catalog = {
    global: [
      wireSkill({ id: "g1", name: "git-helper" }),
      wireSkill({ id: "g2", name: "sql-writer" }),
    ],
    subjects: {
      alice: [wireSkill({ id: "a1", name: "sql-writer", description: "alice's" })],
    },
  };

  it("returns the published global layer with a catalogVersion and ETag", async () => {
    const mock = new MockCloud({ catalog });
    const sdk = makeSdk(mock);
    const result = await sdk.catalog.pull();
    expect(result.notModified).toBe(false);
    if (result.notModified) throw new Error("unreachable");
    expect(result.skills.map((s) => s.id)).toEqual(["g1", "g2"]);
    expect(result.etag).toBe(`"${result.catalogVersion}"`);
  });

  it("revalidates with the previous etag and gets notModified", async () => {
    const mock = new MockCloud({ catalog });
    const sdk = makeSdk(mock);
    const first = await sdk.catalog.pull();
    if (first.notModified) throw new Error("unreachable");
    const second = await sdk.catalog.pull({ etag: first.etag ?? undefined });
    expect(second.notModified).toBe(true);
    expect(second.etag).toBe(first.etag);
  });

  it("overlays a subject scope: subject wins by name; unknown scope = global", async () => {
    const mock = new MockCloud({ catalog });
    const sdk = makeSdk(mock);
    const alice = await sdk.catalog.pull({ scope: "alice" });
    if (alice.notModified) throw new Error("unreachable");
    expect(alice.skills.map((s) => s.id).sort()).toEqual(["a1", "g1"]);
    expect(alice.skills.find((s) => s.id === "a1")?.description).toBe("alice's");

    const unknown = await sdk.catalog.pull({ scope: "carol" });
    if (unknown.notModified) throw new Error("unreachable");
    expect(unknown.skills.map((s) => s.id)).toEqual(["g1", "g2"]);
  });

  it("serves only published skills — drafts stay invisible", async () => {
    const mock = new MockCloud({ catalog });
    const sdk = makeSdk(mock);
    await sdk.skills.create({ name: "draft-thing", description: "d", body: "b" });
    const result = await sdk.catalog.pull();
    if (result.notModified) throw new Error("unreachable");
    expect(result.skills.map((s) => s.name)).not.toContain("draft-thing");
  });

  it("rejects a bad API key", async () => {
    const mock = new MockCloud({ catalog });
    const sdk = new RatelCloudSdk({
      apiKey: "rtl_wrong",
      baseUrl: "https://mock.test/api/v1",
      fetch: mock.fetch,
    });
    await expect(sdk.catalog.pull()).rejects.toMatchObject({ code: "unauthorized" });
  });
});
