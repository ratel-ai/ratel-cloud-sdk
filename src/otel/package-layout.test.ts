/**
 * Guards the packaging contract behind the `/otel` subpath.
 *
 * The whole reason telemetry lives on a subpath with optional peer dependencies is
 * that `import "@ratel-ai/cloud-sdk"` must stay dependency-free: a consumer managing
 * a skill catalog should never install the OpenTelemetry tree. That property is
 * invisible at runtime and easy to break with one convenient re-export, so it is
 * asserted here rather than trusted.
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "..");
const PKG = JSON.parse(readFileSync(resolve(SRC, "../package.json"), "utf8")) as {
  exports: Record<string, { types: string; default: string }>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};

/**
 * Every `from "…"` specifier in a module, ignoring comments — the doc blocks here
 * carry example wiring that imports packages this package must not depend on.
 */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments, incl. JSDoc examples
    .replace(/^\s*\/\/.*$/gm, ""); // whole-line comments (never a URL)
  return [...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1] as string);
}

/** Walk the module graph from an entry point, following relative imports only. */
function reachableFrom(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      if (!spec.startsWith(".")) continue;
      // Source is authored with .js specifiers (NodeNext); resolve back to .ts.
      queue.push(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  }
  return [...seen];
}

describe("root entry point", () => {
  const rootGraph = reachableFrom(join(SRC, "index.ts"));

  it("reaches no OpenTelemetry import", () => {
    const offenders = rootGraph.filter((file) =>
      importsOf(file).some((spec) => spec.startsWith("@opentelemetry/")),
    );
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("does not pull in the telemetry module at all", () => {
    const otel = rootGraph.filter((file) => relative(SRC, file).startsWith("otel"));
    expect(otel).toEqual([]);
  });

  it("declares no runtime dependencies", () => {
    expect(PKG.dependencies ?? {}).toEqual({});
  });
});

describe("the /otel subpath", () => {
  it("is exported from package.json", () => {
    expect(PKG.exports["./otel"]).toEqual({
      types: "./dist/otel/index.d.ts",
      default: "./dist/otel/index.js",
    });
  });

  it("declares every OpenTelemetry package it imports as an optional peer", () => {
    const used = new Set(
      reachableFrom(join(SRC, "otel/index.ts"))
        .flatMap(importsOf)
        .filter((spec) => spec.startsWith("@opentelemetry/")),
    );
    expect(used.size).toBeGreaterThan(0);

    for (const pkg of used) {
      expect(PKG.peerDependencies?.[pkg], `${pkg} missing from peerDependencies`).toBeDefined();
      expect(PKG.peerDependenciesMeta?.[pkg]?.optional, `${pkg} peer must be optional`).toBe(true);
      expect(PKG.devDependencies?.[pkg], `${pkg} missing from devDependencies`).toBeDefined();
    }
  });
});
