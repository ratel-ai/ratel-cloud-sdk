import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RatelCloudSdk } from "../index.js";
import type { CatalogResponse, CatalogResponseV2, CatalogV2 } from "../types.js";
import { MockCloud } from "./mock-cloud.js";

interface EtagVector {
  name: string;
  catalog: string;
  scope: string | null;
  expect: { resolvedIds: string[]; etag: string };
}

interface InmVector {
  name: string;
  current: string;
  of?: string;
  ifNoneMatch: { kind: string };
  expect: 200 | 304;
}

interface Vectors {
  catalogs: Record<string, CatalogV2>;
  etag: EtagVector[];
  inm: InmVector[];
}

const vectors: Vectors = JSON.parse(
  readFileSync(new URL("./catalog-vectors-v2.json", import.meta.url), "utf8"),
);

describe("MockCloud catalog protocol v2", () => {
  it("uses the v2 error envelope for an invalid API key", async () => {
    const mock = new MockCloud();
    const response = await mock.fetch("https://mock.test/v2/catalog", {
      headers: { authorization: "Bearer wrong" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: "Invalid or revoked API key." },
    });
  });

  for (const vector of vectors.etag) {
    it(`reproduces ${vector.name}`, async () => {
      const catalog = vectors.catalogs[vector.catalog];
      if (!catalog) throw new Error(`unknown catalog: ${vector.catalog}`);
      const mock = new MockCloud({ catalog });

      const response = await catalogRequest(mock, 2, vector.scope);
      const body = (await response.json()) as CatalogResponseV2;

      expect(response.status).toBe(200);
      expect(response.headers.get("etag")).toBe(vector.expect.etag);
      expect(body.catalogVersion).toBe(vector.expect.etag.slice(1, -1));
      expect(body.skills.map((skill) => skill.id)).toEqual(vector.expect.resolvedIds);
    });
  }

  for (const vector of vectors.inm) {
    it(`reproduces If-None-Match ${vector.name}`, async () => {
      const current = etagVector(vector.current);
      const catalog = vectors.catalogs[current.catalog];
      if (!catalog) throw new Error(`unknown catalog: ${current.catalog}`);
      const other = vector.of ? etagVector(vector.of).expect.etag : undefined;
      const mock = new MockCloud({ catalog });

      const response = await catalogRequest(
        mock,
        2,
        current.scope,
        headerFor(vector.ifNoneMatch.kind, current.expect.etag, other),
      );

      expect(response.status).toBe(vector.expect);
    });
  }
});

it("serves v1 without the override and versions v2 when only the override changes", async () => {
  const mock = new MockCloud();
  const sdk = new RatelCloudSdk({
    apiKey: mock.apiKey,
    baseUrl: "https://mock.test/api/v1",
    fetch: mock.fetch,
  });
  const skill = await sdk.skills.create({
    name: "deploy-checklist",
    description: "How to deploy safely.",
    body: "# Deploy",
    status: "published",
  });
  const firstV1 = await catalogRequest(mock, 1, null);
  const firstV2 = await catalogRequest(mock, 2, null);
  const firstV1Body = (await firstV1.json()) as CatalogResponse;
  const firstV2Body = (await firstV2.json()) as CatalogResponseV2;
  expect(firstV1Body.skills[0]).not.toHaveProperty("searchableDescription");
  expect(firstV2Body.skills[0]?.searchableDescription).toBeNull();

  await sdk.skills.update(skill.id, {
    expectedVersion: skill.version,
    searchableDescription: "release production rollback canary",
  });

  const unchangedV1 = await catalogRequest(mock, 1, null, firstV1.headers.get("etag"));
  const changedV2 = await catalogRequest(mock, 2, null, firstV2.headers.get("etag"));
  const changedV2Body = (await changedV2.json()) as CatalogResponseV2;
  expect(unchangedV1.status).toBe(304);
  expect(changedV2.status).toBe(200);
  expect(changedV2Body.skills[0]?.searchableDescription).toBe("release production rollback canary");
});

function etagVector(name: string): EtagVector {
  const vector = vectors.etag.find((candidate) => candidate.name === name);
  if (!vector) throw new Error(`unknown etag vector: ${name}`);
  return vector;
}

function catalogRequest(
  mock: MockCloud,
  version: 1 | 2,
  scope: string | null,
  ifNoneMatch?: string | null,
): Promise<Response> {
  const query = scope === null ? "" : `?scope=${encodeURIComponent(scope)}`;
  const headers: Record<string, string> = { authorization: `Bearer ${mock.apiKey}` };
  if (ifNoneMatch) headers["if-none-match"] = ifNoneMatch;
  return mock.fetch(`https://mock.test/v${version}/catalog${query}`, { headers });
}

function headerFor(kind: string, current: string, other?: string): string | null {
  switch (kind) {
    case "self":
      return current;
    case "weakSelf":
      return `W/${current}`;
    case "star":
      return "*";
    case "listWithSelf":
      return `"deadbeef", ${current}`;
    case "listMiss":
      return '"deadbeef", "cafebabe"';
    case "absent":
      return null;
    case "other":
      if (!other) throw new Error('If-None-Match kind "other" requires a vector');
      return other;
    default:
      throw new Error(`unknown If-None-Match kind: ${kind}`);
  }
}
