import { RuntimeCatalogClient } from "../runtime-catalog.js";
import { type CloudSdkOptions, Transport } from "../transport.js";
import type { RuntimeCatalogOverride } from "../types.js";

export interface CloudDefinitionsOverlaySource {
  fetch(ifNoneMatch?: string): Promise<CloudDefinitionsOverlayResponse>;
}

export interface CloudDefinitionsAttachment {
  refresh(): Promise<boolean>;
}

export interface CloudDefinitionsRuntimeCatalog {
  attachDefinitionOverrides?(options: {
    readonly useDefinitionOverrides: true;
    readonly source: CloudDefinitionsOverlaySource;
  }): Promise<CloudDefinitionsAttachment>;
}

type CloudDefinitionsOverlayResponse =
  | { readonly status: 304 }
  | {
      readonly status: 200;
      readonly etag: string;
      readonly body: { readonly overrides: readonly RuntimeCatalogOverride[] };
    };

/** Bridge the Cloud override client into the core SDK's injected overlay seam. */
export function createCloudDefinitionsSource(
  options: CloudSdkOptions,
): CloudDefinitionsOverlaySource {
  const client = new RuntimeCatalogClient(new Transport(options));
  return {
    fetch: async (ifNoneMatch) => {
      const result = await client.listOverrides({ ifNoneMatch });
      if (result.notModified) return { status: 304 };
      if (result.etag === null) {
        throw new Error("Ratel Cloud definitions response is missing a strong ETag");
      }
      return {
        status: 200,
        etag: result.etag,
        body: { overrides: result.overrides },
      };
    },
  };
}
