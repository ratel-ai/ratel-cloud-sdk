import type { Transport } from "./transport.js";
import type { CatalogResponse, WireSkill } from "./types.js";

export interface PullOptions {
  /** Subject scope (opaque end-user id). Absent ⇒ the global layer. */
  scope?: string | undefined;
  /** ETag from a previous pull; a match returns `{ notModified: true }`. */
  etag?: string | undefined;
}

export type PullResult =
  | { notModified: false; skills: WireSkill[]; catalogVersion: string; etag: string | null }
  | { notModified: true; etag: string };

/**
 * Read-only view of the published catalog (`GET /catalog`, the frozen
 * `protocol/v1` pull) — for tooling and CI diffing. This is deliberately NOT a
 * runtime replica: agents should sync through the `@ratel-ai/cloud` loader,
 * which owns refresh, ownership, and staleness. See README "Scope".
 */
export class CatalogClient {
  constructor(private readonly transport: Transport) {}

  async pull(options: PullOptions = {}): Promise<PullResult> {
    const headers: Record<string, string> = {};
    if (options.etag !== undefined) headers["if-none-match"] = options.etag;
    const res = await this.transport.request("GET", "/catalog", {
      query: { scope: options.scope },
      headers,
      acceptStatuses: [304],
    });
    const etag = res.headers.get("etag");
    if (res.status === 304) {
      return { notModified: true, etag: etag ?? options.etag ?? "" };
    }
    const body = res.json as CatalogResponse;
    return { notModified: false, skills: body.skills, catalogVersion: body.catalogVersion, etag };
  }
}
