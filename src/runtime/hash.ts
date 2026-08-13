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
  return createHash("sha256")
    .update(stableJson(canonicalSnapshot(snapshot)), "utf8")
    .digest("hex");
}

function canonicalSnapshot(snapshot: RuntimeCatalogSnapshot): CanonicalCatalogSnapshot {
  return {
    source_id: snapshot.source_id,
    tools: snapshot.tools
      .map((tool) => ({
        toolId: tool.id,
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: jsonRecord(tool.inputSchema),
        outputSchema: jsonRecord(tool.outputSchema),
        metadata: jsonRecord(tool.metadata),
      }))
      .sort((left, right) => Buffer.compare(Buffer.from(left.toolId), Buffer.from(right.toolId))),
  };
}

function jsonRecord(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
