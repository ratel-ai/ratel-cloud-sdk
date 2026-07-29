/**
 * The signal filter that makes Ratel a well-behaved co-tenant on a provider it
 * does not own.
 *
 * OpenTelemetry's coexistence model is one provider with many processors, every
 * span fanning out to all of them. A host already running Langfuse or the Vercel
 * AI SDK adds a Ratel processor to their provider's `spanProcessors` to dual-export,
 * and this predicate keeps the host's framework noise (`ai.*` wrapper spans, HTTP
 * auto-instrumentation, everything else) out of Ratel Cloud.
 *
 * Emission and delivery are separate: a span reaches every processor intact, and
 * only then does each destination's filter decide. Nothing is dropped at the source.
 */

import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

/** Predicate deciding whether a finished span is forwarded to Ratel Cloud. */
export type SpanFilter = (span: ReadableSpan) => boolean;

/**
 * Default span filter: forward only signal-bearing spans — a `ratel.*` span name,
 * or any attribute key under `gen_ai.*` / `ratel.*`.
 *
 * This is what lets Ratel share a provider with e.g. Langfuse + the Vercel AI SDK
 * and ingest only the gen_ai/ratel signal: the AI SDK's `gen_ai.*` spans plus
 * Ratel's own `ratel.search` / `execute_tool`, while the framework's `ai.*` wrapper
 * spans stay out.
 *
 * Note it matches on span *name* and *attribute keys*, never on the emitting scope —
 * both Ratel and `@ai-sdk/otel` emit an `execute_tool <id>` span, and `gen_ai.*`
 * attributes appear on both. Selecting by signal rather than by emitter is deliberate:
 * Ratel Cloud wants the GenAI signal whoever produced it.
 *
 * The corollary is worth knowing: **any** `ratel.*` attribute key opts a span in,
 * including one you added for your own bookkeeping. Namespace incidental attributes
 * outside `ratel.*` unless you mean to send the span.
 */
export function ratelSignalFilter(span: ReadableSpan): boolean {
  if (span.name.startsWith("ratel.")) return true;
  for (const key of Object.keys(span.attributes)) {
    if (key.startsWith("gen_ai.") || key.startsWith("ratel.")) return true;
  }
  return false;
}
