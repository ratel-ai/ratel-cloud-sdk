import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Catalog, SKILL_FIELDS, type WireSkill } from "./types.js";
import { canonicalSet, ifNoneMatchMatches, resolve } from "./wire.js";

/**
 * protocol/v1 conformance: reproduce every vendored vector byte-for-byte
 * (`catalog-vectors.json`, a copy of the protocol's `vectors.json`). A failure
 * here means this port has drifted from the frozen contract.
 */

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
  catalogs: Record<string, Catalog>;
  etag: EtagVector[];
  equalEtags: string[][];
  distinctEtags: string[][];
  inm: InmVector[];
  wire: { skillFields: string[]; forbiddenFieldSubstrings: string[] };
}

const vectors: Vectors = JSON.parse(
  readFileSync(new URL("./testing/catalog-vectors.json", import.meta.url), "utf8"),
);

function etagFor(vectorName: string): { etag: string; skills: WireSkill[] } {
  const vec = vectors.etag.find((e) => e.name === vectorName);
  if (!vec) throw new Error(`unknown etag vector: ${vectorName}`);
  const catalog = vectors.catalogs[vec.catalog];
  if (!catalog) throw new Error(`unknown catalog: ${vec.catalog}`);
  const skills = resolve(catalog, vec.scope);
  const hex = createHash("sha256").update(canonicalSet(skills), "utf8").digest("hex");
  return { etag: `"${hex}"`, skills };
}

describe("etag vectors", () => {
  for (const vec of vectors.etag) {
    it(vec.name, () => {
      const { etag, skills } = etagFor(vec.name);
      expect(skills.map((s) => s.id)).toEqual(vec.expect.resolvedIds);
      expect(etag).toBe(vec.expect.etag);
    });
  }
});

describe("canonicalization invariants", () => {
  for (const group of vectors.equalEtags) {
    it(`equal: ${group.join(" == ")}`, () => {
      const etags = group.map((name) => etagFor(name).etag);
      for (const etag of etags) expect(etag).toBe(etags[0]);
    });
  }
  for (const group of vectors.distinctEtags) {
    it(`distinct: ${group.join(" != ")}`, () => {
      const etags = group.map((name) => etagFor(name).etag);
      expect(new Set(etags).size).toBe(etags.length);
    });
  }
});

describe("if-none-match vectors", () => {
  function headerFor(vec: InmVector, currentEtag: string): string | null {
    switch (vec.ifNoneMatch.kind) {
      case "self":
        return currentEtag;
      case "weakSelf":
        return `W/${currentEtag}`;
      case "star":
        return "*";
      case "listWithSelf":
        return `"deadbeef", ${currentEtag}`;
      case "listMiss":
        return '"deadbeef", "cafebabe"';
      case "absent":
        return null;
      case "other": {
        if (!vec.of) throw new Error(`inm vector ${vec.name}: kind "other" requires "of"`);
        return etagFor(vec.of).etag;
      }
      default:
        throw new Error(`unknown inm kind: ${vec.ifNoneMatch.kind}`);
    }
  }

  for (const vec of vectors.inm) {
    it(vec.name, () => {
      const current = etagFor(vec.current).etag;
      const matches = ifNoneMatchMatches(headerFor(vec, current), current);
      expect(matches ? 304 : 200).toBe(vec.expect);
    });
  }
});

describe("wire projection", () => {
  it("serves exactly the frozen field set", () => {
    expect([...SKILL_FIELDS]).toEqual(vectors.wire.skillFields);
  });
  it("no field name contains a forbidden substring", () => {
    for (const field of SKILL_FIELDS) {
      for (const forbidden of vectors.wire.forbiddenFieldSubstrings) {
        expect(field.toLowerCase()).not.toContain(forbidden);
      }
    }
  });
});
