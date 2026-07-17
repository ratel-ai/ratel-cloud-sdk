/**
 * The frozen `protocol/v1` canonicalization, scope-overlay, and conditional-GET
 * matcher — a faithful, dependency-free port of the reference verifier
 * (`protocol/v1/conformance/verify.mjs` in the ratel repo; the text spec in
 * `protocol/v1/README.md` is normative). Pure string/byte functions only: the
 * SHA-256 that turns canonical bytes into an ETag is intentionally NOT here, so
 * this module runs on any runtime. `wire.test.ts` pins conformance against the
 * vendored vectors byte-for-byte.
 *
 * Anything that changes the bytes — field set, order, canonicalization, the
 * resolve/overlay rule — is a breaking protocol change (a `/v2` event), not a
 * local refactor.
 */

import type { Catalog, WireSkill } from "./types.js";

const encoder = new TextEncoder();

/** UTF-8 bytewise comparison — drives the set sort-by-id and metadata key sort. */
function byteCompare(a: string, b: string): number {
  const ba = encoder.encode(a);
  const bb = encoder.encode(b);
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    const d = (ba[i] as number) - (bb[i] as number);
    if (d !== 0) return d;
  }
  return ba.length - bb.length;
}

/**
 * Canonical JSON for one projected skill: fixed field order, metadata keys
 * byte-sorted, arrays in authored order, minimal JSON escaping, raw UTF-8, no
 * insignificant whitespace.
 */
export function canonicalSkill(skill: WireSkill): string {
  const s = JSON.stringify;
  const metaKeys = Object.keys(skill.metadata ?? {}).sort(byteCompare);
  const meta = `{${metaKeys.map((k) => `${s(k)}:${s(skill.metadata[k])}`).join(",")}}`;
  return (
    `{"id":${s(skill.id)},"name":${s(skill.name)},"description":${s(skill.description)}` +
    `,"tags":${s(skill.tags)},"tools":${s(skill.tools)},"metadata":${meta},"body":${s(skill.body)}}`
  );
}

function sortById(skills: WireSkill[]): WireSkill[] {
  return [...skills].sort((a, b) => byteCompare(a.id, b.id));
}

/** Canonical bytes for a resolved set: sorted by id, compact JSON array. */
export function canonicalSet(skills: WireSkill[]): string {
  return `[${sortById(skills).map(canonicalSkill).join(",")}]`;
}

/**
 * Resolve the published set for a scope: absent scope ⇒ global layer; a named
 * subject ⇒ its layer overlaid on the global layer, subject winning on `name`
 * collision; an unknown subject ⇒ the global layer. Sorted by id.
 */
export function resolve(catalog: Catalog, scope: string | null | undefined): WireSkill[] {
  const global = catalog.global ?? [];
  if (scope == null) return sortById(global);
  const layer = catalog.subjects?.[scope] ?? [];
  const byName = new Map<string, WireSkill>();
  for (const sk of global) byName.set(sk.name, sk);
  for (const sk of layer) byName.set(sk.name, sk);
  return sortById([...byName.values()]);
}

/** Strip a `W/` weak prefix and surrounding quotes to the opaque tag value. */
function opaque(tag: string): string {
  let t = tag.trim();
  if (t.startsWith("W/")) t = t.slice(2).trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  return t;
}

/**
 * `If-None-Match` matcher (weak comparison, RFC 7232 §3.2). True ⇒ cache hit
 * (304). `*` matches any current representation.
 */
export function ifNoneMatchMatches(
  headerValue: string | null | undefined,
  currentEtag: string,
): boolean {
  if (headerValue == null) return false;
  const v = headerValue.trim();
  if (v === "*") return true;
  const current = opaque(currentEtag);
  return v.split(",").some((tok) => {
    const o = opaque(tok);
    return o.length > 0 && o === current;
  });
}
