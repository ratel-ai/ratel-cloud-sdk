import { createHash } from "node:crypto";
import type { RuntimeCatalogSnapshot } from "../types.js";

interface CanonicalCatalogTool {
  readonly toolId: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown> | null;
  readonly outputSchema: Record<string, unknown> | null;
  readonly metadata: Record<string, unknown> | null;
}

interface CanonicalCatalogSnapshot {
  readonly source_id: string;
  readonly tools: readonly CanonicalCatalogTool[];
}

/** Return Cloud's canonical SHA-256 content hash for a full source snapshot. */
export function hashCatalogSnapshot(snapshot: RuntimeCatalogSnapshot): string {
  const canonical = stableJson(canonicalSnapshot(snapshot));
  if (canonical === undefined) throw new TypeError("catalog snapshot cannot be serialized");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function canonicalSnapshot(snapshot: RuntimeCatalogSnapshot): CanonicalCatalogSnapshot {
  return {
    source_id: snapshot.source_id,
    tools: snapshot.tools
      .map((tool) => ({
        toolId: tool.id,
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema ?? null,
        outputSchema: tool.outputSchema ?? null,
        metadata: tool.metadata ?? null,
      }))
      .sort((left, right) => Buffer.compare(Buffer.from(left.toolId), Buffer.from(right.toolId))),
  };
}

function stableJson(value: unknown, key = ""): string | undefined {
  const transformed = toJsonValue(value, key);
  if (!Object.is(transformed, value)) return stableJson(transformed, key);
  if (Array.isArray(value)) {
    return `[${Array.from(
      { length: value.length },
      (_, index) => stableJson(value[index], String(index)) ?? "null",
    ).join(",")}]`;
  }
  if (isRecord(value)) {
    const properties = Object.keys(value)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .flatMap((property) => {
        const json = stableJson(value[property], property);
        return json === undefined ? [] : `${JSON.stringify(property)}:${json}`;
      });
    return `{${properties.join(",")}}`;
  }
  return JSON.stringify(value);
}

function toJsonValue(value: unknown, key: string): unknown {
  if (!isRecord(value) && !Array.isArray(value)) return value;
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") return toJSON.call(value, key);
  if (value instanceof Number || value instanceof String || value instanceof Boolean) {
    return value.valueOf();
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
