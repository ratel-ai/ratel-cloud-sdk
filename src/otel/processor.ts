/**
 * The Ratel Cloud destination: one processor you add to a provider you own.
 *
 * Ratel ships no provider bootstrap. The host always owns the `NodeSDK` and
 * therefore owns flush and shutdown; this processor is a composable tenant on it:
 *
 * ```ts
 * const sdk = new NodeSDK({
 *   spanProcessors: [
 *     new RatelSpanProcessor(),   // → Ratel Cloud
 *     ...yourExistingProcessors,  // keep working untouched
 *   ],
 * });
 * sdk.start();
 * ```
 *
 * It is thin sugar over a standard `BatchSpanProcessor` + OTLP exporter: Cloud
 * defaults for endpoint and auth, plus a signal filter so Ratel ingests only the
 * `gen_ai.*` / `ratel.*` stream rather than everything the host's provider sees.
 *
 * Traces are the whole surface. Content capture rides the same signal — Cloud reads
 * the `gen_ai.client.inference.operation.details` EventRecord as a span event on the
 * anchor span — so forwarding spans forwards captured content with them. There is no
 * separate Logs processor because Cloud consumes no Logs signal.
 */

import type { Context } from "@opentelemetry/api";
import { propagation } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { type RatelOtlpOptions, resolveOtlpConfig } from "./config.js";
import { ratelSignalFilter, type SpanFilter } from "./filters.js";

/**
 * Baggage keys under this prefix are copied onto every span as attributes at
 * `onStart` — the framework-agnostic seam for experiment arm stamping (RS-33).
 */
export const EXPERIMENT_BAGGAGE_PREFIX = "ratel.experiment.";

/** Options for {@link RatelSpanProcessor}. */
export interface RatelSpanProcessorOptions extends RatelOtlpOptions {
  /**
   * Set `false` for a strict no-op: no endpoint/auth resolution, no environment
   * read, no exporter, no baggage copying. The safe way to keep the wiring in
   * place while telemetry is off.
   */
  enabled?: boolean;
  /** Override {@link ratelSignalFilter}; `() => true` forwards every span. */
  spanFilter?: SpanFilter;
  /**
   * Replace the default OTLP exporter — for tests, proxies, or a transport of your
   * own. Supplying one bypasses endpoint/auth resolution entirely.
   */
  exporter?: SpanExporter;
}

/**
 * A filtered `BatchSpanProcessor` over the Ratel Cloud OTLP exporter.
 *
 * Carries no resource: the host's provider owns `service.name`. Registers nothing
 * globally — in particular it never installs or replaces the host's `ContextManager`,
 * though {@link EXPERIMENT_BAGGAGE_PREFIX} copying does require the host to have one
 * registered for baggage to propagate at all.
 *
 * One deliberate cross-tenant effect: the experiment attributes are written onto the
 * span itself at `onStart`, so every processor on the shared provider sees them, not
 * just this one. That is what makes arm stamping framework-agnostic.
 */
export class RatelSpanProcessor implements SpanProcessor {
  private readonly inner: SpanProcessor | undefined;
  private readonly spanFilter: SpanFilter;

  constructor(options: RatelSpanProcessorOptions = {}) {
    const { enabled = true, spanFilter = ratelSignalFilter, exporter, ...otlp } = options;
    this.spanFilter = spanFilter;
    // Short-circuit before touching config or the environment: `enabled: false`
    // must be observably free of side effects.
    this.inner = enabled ? new BatchSpanProcessor(exporter ?? traceExporter(otlp)) : undefined;
  }

  onStart(span: Span, parentContext: Context): void {
    if (!this.inner) return;
    copyExperimentBaggage(span, parentContext);
    this.inner.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    if (!this.inner) return;
    if (this.spanFilter(span)) this.inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.inner?.forceFlush() ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.inner?.shutdown() ?? Promise.resolve();
  }
}

/**
 * Build the OTLP `http/protobuf` trace exporter at the resolved Ratel Cloud route.
 * Exposed for callers batching it themselves; {@link RatelSpanProcessor} wraps it.
 */
export function ratelTraceExporter(options: RatelOtlpOptions = {}): OTLPTraceExporter {
  return traceExporter(options);
}

function traceExporter(options: RatelOtlpOptions): OTLPTraceExporter {
  const { url, headers } = resolveOtlpConfig(options);
  return new OTLPTraceExporter({ url, headers });
}

/**
 * Copy `ratel.experiment.*` baggage entries onto the span as attributes. Reads the
 * host's context; never registers or replaces a `ContextManager` of its own.
 */
function copyExperimentBaggage(span: Span, parentContext: Context): void {
  const baggage = propagation.getBaggage(parentContext);
  if (!baggage) return;
  for (const [key, entry] of baggage.getAllEntries()) {
    if (key.startsWith(EXPERIMENT_BAGGAGE_PREFIX)) span.setAttribute(key, entry.value);
  }
}
