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
  it("lists no overrides when none have been set", async () => {
    const sdk = makeSdk();

    await expect(sdk.runtimeCatalog.listOverrides()).resolves.toEqual({ overrides: [] });
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

    await expect(makeSdk(mock).runtimeCatalog.listOverrides()).resolves.toEqual({ overrides: [] });
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

  it("serves the fixed /v1/runtime-catalog/overrides wire path", async () => {
    const mock = new MockCloud();
    const response = await mock.fetch("https://mock.test/v1/runtime-catalog/overrides", {
      headers: { authorization: `Bearer ${mock.apiKey}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ overrides: [] });
  });
});
