import type { Transport } from "./transport.js";
import type { RuntimeCatalogOverridesResponse } from "./types.js";

/** Bearer-authenticated pull surface for operator-authored runtime catalog overrides. */
export class RuntimeCatalogClient {
  constructor(private readonly transport: Transport) {}

  async listOverrides(): Promise<RuntimeCatalogOverridesResponse> {
    return this.transport.json<RuntimeCatalogOverridesResponse>(
      "GET",
      "/runtime-catalog/overrides",
    );
  }
}
