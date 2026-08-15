import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type CatalogV2, V2_SKILL_FIELDS, type WireSkillV2 } from "./types.js";
import { canonicalSetV2, canonicalSkillV2, ifNoneMatchMatches, resolveV2 } from "./wire.js";

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

interface CanonicalVector {
  name: string;
  skill: WireSkillV2;
  expect: string;
}

interface Vectors {
  catalogs: Record<string, CatalogV2>;
  canonical: CanonicalVector[];
  etag: EtagVector[];
  equalEtags: string[][];
  distinctEtags: string[][];
  inm: InmVector[];
  wire: { skillFields: string[]; forbiddenFieldSubstrings: string[] };
}

const vectors: Vectors = JSON.parse(
  readFileSync(new URL("./testing/catalog-vectors-v2.json", import.meta.url), "utf8"),
);

function etagFor(vectorName: string): { etag: string; skills: WireSkillV2[] } {
  const vector = vectors.etag.find((candidate) => candidate.name === vectorName);
  if (!vector) throw new Error(`unknown etag vector: ${vectorName}`);
  const catalog = vectors.catalogs[vector.catalog];
  if (!catalog) throw new Error(`unknown catalog: ${vector.catalog}`);
  const skills = resolveV2(catalog, vector.scope);
  const hex = createHash("sha256").update(canonicalSetV2(skills), "utf8").digest("hex");
  return { etag: `"${hex}"`, skills };
}

describe("protocol/v2 canonicalization", () => {
  for (const vector of vectors.canonical) {
    it(vector.name, () => {
      expect(canonicalSkillV2(vector.skill)).toBe(vector.expect);
    });
  }

  for (const vector of vectors.etag) {
    it(vector.name, () => {
      const { etag, skills } = etagFor(vector.name);
      expect(skills.map((skill) => skill.id)).toEqual(vector.expect.resolvedIds);
      expect(etag).toBe(vector.expect.etag);
    });
  }

  for (const group of vectors.equalEtags) {
    it(`equal: ${group.join(" == ")}`, () => {
      const etags = group.map((name) => etagFor(name).etag);
      expect(new Set(etags)).toHaveLength(1);
    });
  }

  for (const group of vectors.distinctEtags) {
    it(`distinct: ${group.join(" != ")}`, () => {
      expect(new Set(group.map((name) => etagFor(name).etag))).toHaveLength(group.length);
    });
  }
});

describe("protocol/v2 If-None-Match", () => {
  for (const vector of vectors.inm) {
    it(vector.name, () => {
      const current = etagFor(vector.current).etag;
      const other = vector.of ? etagFor(vector.of).etag : undefined;
      const header = headerFor(vector.ifNoneMatch.kind, current, other);
      expect(ifNoneMatchMatches(header, current) ? 304 : 200).toBe(vector.expect);
    });
  }
});

describe("protocol/v2 wire projection", () => {
  it("serves exactly the frozen field set", () => {
    expect([...V2_SKILL_FIELDS]).toEqual(vectors.wire.skillFields);
  });

  it("contains no secret-bearing field names", () => {
    for (const field of V2_SKILL_FIELDS) {
      for (const forbidden of vectors.wire.forbiddenFieldSubstrings) {
        expect(field.toLowerCase()).not.toContain(forbidden);
      }
    }
  });
});

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
