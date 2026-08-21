import type {
  ExperimentalDefinitionOverlaySource,
  ExperimentalDefinitionOverridesAttachment,
  ExperimentalDefinitionOverridesRuntimeCatalog,
} from "@ratel-ai/sdk";
import { RuntimeCatalogClient } from "../runtime-catalog.js";
import { type CloudSdkOptions, Transport } from "../transport.js";

export type CloudDefinitionsOverlaySource = ExperimentalDefinitionOverlaySource;
export type CloudDefinitionsAttachment = ExperimentalDefinitionOverridesAttachment;
export type CloudDefinitionsRuntimeCatalog = Partial<
  Pick<ExperimentalDefinitionOverridesRuntimeCatalog, "experimentalAttachDefinitionOverrides">
>;

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
