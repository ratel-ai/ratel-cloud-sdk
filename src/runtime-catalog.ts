import type { Transport } from "./transport.js";
import type {
  ListRuntimeCatalogOverridesOptions,
  RuntimeCatalogOverridesFreshResult,
  RuntimeCatalogOverridesResponse,
  RuntimeCatalogOverridesResult,
} from "./types.js";

/** Bearer-authenticated pull surface for operator-authored runtime catalog overrides. */
export class RuntimeCatalogClient {
  constructor(private readonly transport: Transport) {}

  async listOverrides(): Promise<RuntimeCatalogOverridesFreshResult>;
  async listOverrides(
    options: ListRuntimeCatalogOverridesOptions,
  ): Promise<RuntimeCatalogOverridesResult>;
  async listOverrides(
    options: ListRuntimeCatalogOverridesOptions = {},
  ): Promise<RuntimeCatalogOverridesResult> {
    const headers: Record<string, string> = {};
    if (options.ifNoneMatch) headers["if-none-match"] = options.ifNoneMatch;
    const response = await this.transport.request("GET", "/runtime-catalog/overrides", {
      headers,
      acceptStatuses: [304],
    });
    const etag = response.headers.get("etag");
    if (response.status === 304) return { notModified: true, etag };

    const body = response.json as RuntimeCatalogOverridesResponse;
    return {
      notModified: false,
      etag,
      overrides: body.overrides,
    };
  }
}
