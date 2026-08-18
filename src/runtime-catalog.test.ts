import { describe, expect, it } from "vitest";
import { RatelCloudSdk } from "./index.js";
import { MockCloud } from "./testing/mock-cloud.js";

function makeSdk(mock = new MockCloud()): RatelCloudSdk {
  return new RatelCloudSdk({
    apiKey: mock.apiKey,
    baseUrl: "https://mock.test/api/v1",
    fetch: mock.fetch,
  });
}

describe("RuntimeCatalogClient", () => {
  it("surfaces a fresh response with its ETag", async () => {
    const sdk = new RatelCloudSdk({
      apiKey: "rtl_test_key",
      baseUrl: "https://mock.test/api/v1",
      fetch: async () =>
        Response.json({ overrides: [] }, { headers: { etag: '"runtime-catalog-overrides-v1"' } }),
    });

    await expect(sdk.runtimeCatalog.listOverrides()).resolves.toEqual({
      notModified: false,
      etag: '"runtime-catalog-overrides-v1"',
      overrides: [],
    });
  });

  it("surfaces a matching ETag as not modified", async () => {
    let ifNoneMatch: string | null = null;
    const sdk = new RatelCloudSdk({
      apiKey: "rtl_test_key",
      baseUrl: "https://mock.test/api/v1",
      fetch: async (_input, init) => {
        ifNoneMatch = new Headers(init?.headers).get("if-none-match");
        return new Response(null, {
          status: 304,
          headers: { etag: '"runtime-catalog-overrides-v1"' },
        });
      },
    });

    await expect(
      sdk.runtimeCatalog.listOverrides({ ifNoneMatch: '"runtime-catalog-overrides-v1"' }),
    ).resolves.toEqual({
      notModified: true,
      etag: '"runtime-catalog-overrides-v1"',
    });
    expect(ifNoneMatch).toBe('"runtime-catalog-overrides-v1"');
  });

  it("lists no overrides when none have been set", async () => {
    const sdk = makeSdk();
    const result = await sdk.runtimeCatalog.listOverrides();

    expect(result.notModified).toBe(false);
    expect(result.etag).toEqual(expect.any(String));
    expect(result.overrides).toEqual([]);
  });

  it("lists seeded overrides sorted by kind then entry id", async () => {
    const mock = new MockCloud();
    mock.seedRuntimeCatalogOverride({
      kind: "tool",
      entryId: "zebra",
      searchableDescription: "Deploy safely.",
    });
    mock.seedRuntimeCatalogOverride({
      kind: "fact",
      entryId: "account-tier",
      searchableDescription: "Customer plan.",
    });
    mock.seedRuntimeCatalogOverride({
      kind: "tool",
      entryId: "alpha",
      searchableDescription: "Find records.",
    });

    await expect(makeSdk(mock).runtimeCatalog.listOverrides()).resolves.toEqual({
      notModified: false,
      etag: expect.any(String),
      overrides: [
        {
          kind: "fact",
          entryId: "account-tier",
          searchableDescription: "Customer plan.",
        },
        { kind: "tool", entryId: "alpha", searchableDescription: "Find records." },
        { kind: "tool", entryId: "zebra", searchableDescription: "Deploy safely." },
      ],
    });
  });

  it("clears seeded overrides", async () => {
    const mock = new MockCloud();
    mock.seedRuntimeCatalogOverride({
      kind: "skill",
      entryId: "incident-response",
      searchableDescription: "Handle production incidents.",
    });

    mock.clearRuntimeCatalogOverrides();

    await expect(makeSdk(mock).runtimeCatalog.listOverrides()).resolves.toEqual({
      notModified: false,
      etag: expect.any(String),
      overrides: [],
    });
  });

  it("moves the ETag when an override is set and cleared", async () => {
    const mock = new MockCloud();
    const client = makeSdk(mock).runtimeCatalog;
    const empty = await client.listOverrides();
    if (empty.etag === null) throw new Error("MockCloud must serve an ETag");

    mock.seedRuntimeCatalogOverride({
      kind: "tool",
      entryId: "weather_lookup",
      searchableDescription: "Current weather and forecasts.",
    });
    const populated = await client.listOverrides({ ifNoneMatch: empty.etag });
    expect(populated.notModified).toBe(false);
    if (populated.notModified || populated.etag === null) {
      throw new Error("set override must return a fresh ETag");
    }
    expect(populated.etag).not.toBe(empty.etag);
    expect(populated.overrides).toEqual([
      {
        kind: "tool",
        entryId: "weather_lookup",
        searchableDescription: "Current weather and forecasts.",
      },
    ]);

    await expect(client.listOverrides({ ifNoneMatch: populated.etag })).resolves.toEqual({
      notModified: true,
      etag: populated.etag,
    });

    mock.clearRuntimeCatalogOverrides();
    const cleared = await client.listOverrides({ ifNoneMatch: populated.etag });
    expect(cleared).toEqual({
      notModified: false,
      etag: empty.etag,
      overrides: [],
    });
  });

  it("maps an invalid Bearer key to unauthorized", async () => {
    const mock = new MockCloud();
    const sdk = new RatelCloudSdk({
      apiKey: "wrong",
      baseUrl: "https://mock.test/api/v1",
      fetch: mock.fetch,
    });

    await expect(sdk.runtimeCatalog.listOverrides()).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });
  });

  it("serves a strong ETag and 304 for an unchanged empty overlay", async () => {
    const mock = new MockCloud();
    const response = await mock.fetch("https://mock.test/v1/runtime-catalog/overrides", {
      headers: { authorization: `Bearer ${mock.apiKey}` },
    });
    const etag = '"a2c526aab2f489db93635255e88cdd8e07c21b650e8f4e7a323ab9ed4b9c367f"';

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(etag);
    await expect(response.json()).resolves.toEqual({ overrides: [] });

    const unchanged = await mock.fetch("https://mock.test/v1/runtime-catalog/overrides", {
      headers: {
        authorization: `Bearer ${mock.apiKey}`,
        "if-none-match": etag,
      },
    });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("etag")).toBe(etag);
    await expect(unchanged.text()).resolves.toBe("");
  });
});
