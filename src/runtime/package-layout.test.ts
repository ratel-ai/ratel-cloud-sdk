import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CatalogSnapshotsPublisher, hashCatalogSnapshot } from "./index.js";

const PKG = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"),
) as {
  exports: Record<string, { types: string; default: string }>;
};

describe("the /runtime subpath", () => {
  it("is exported from package.json", () => {
    expect(PKG.exports["./runtime"]).toEqual({
      types: "./dist/runtime/index.d.ts",
      default: "./dist/runtime/index.js",
    });
  });

  it("exports catalog snapshot publication and hashing", () => {
    expect(CatalogSnapshotsPublisher).toBeTypeOf("function");
    expect(hashCatalogSnapshot).toBeTypeOf("function");
  });
});
