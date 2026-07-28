/**
 * `@ratel-ai/cloud-sdk/otel` — the Ratel Cloud telemetry destination.
 *
 * Imported from a subpath on purpose: the package root stays dependency-free for
 * consumers who only manage a catalog, and the OpenTelemetry packages are optional
 * peers that only telemetry users install. A missing peer fails at module resolution
 * — explicitly, at import time — rather than somewhere deep in a runtime code path.
 *
 * ```ts
 * import { NodeSDK } from "@opentelemetry/sdk-node";
 * import { RatelSpanProcessor } from "@ratel-ai/cloud-sdk/otel";
 *
 * const sdk = new NodeSDK({ spanProcessors: [new RatelSpanProcessor()] });
 * sdk.start();
 * ```
 *
 * You own the provider; Ratel ships no bootstrap and registers nothing globally.
 * Flush and shutdown belong to the host.
 */

export {
  API_KEY_ENV,
  OTLP_ENDPOINT_ENV,
  type RatelOtlpOptions,
  type ResolvedOtlpConfig,
  resolveOtlpConfig,
} from "./config.js";
export { ratelSignalFilter, type SpanFilter } from "./filters.js";
export {
  EXPERIMENT_BAGGAGE_PREFIX,
  RatelSpanProcessor,
  type RatelSpanProcessorOptions,
  ratelTraceExporter,
} from "./processor.js";
