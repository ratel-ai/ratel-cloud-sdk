/**
 * The signal filter that makes Ratel a well-behaved co-tenant on a provider it
 * does not own.
 *
 * OpenTelemetry's coexistence model is one provider with many processors, every
 * span fanning out to all of them. A host already running Langfuse or the Vercel
 * AI SDK adds a Ratel processor to their provider's `spanProcessors` to dual-export,
 * and this predicate keeps the host's framework noise (`ai.*` wrapper spans, HTTP
 * auto-instrumentation, everything else) out of Ratel Cloud — while still admitting
 * the AI SDK's own model and tool spans, which Cloud normalizes on ingest.
 *
 * Emission and delivery are separate: a span reaches every processor intact, and
 * only then does each destination's filter decide. Nothing is dropped at the source.
 */

import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

/** Predicate deciding whether a finished span is forwarded to Ratel Cloud. */
export type SpanFilter = (span: ReadableSpan) => boolean;

/** Every Vercel AI SDK span name starts here; the prefix anchors the match below. */
const AI_SDK_SPAN_PREFIX = "ai.";

/**
 * Span-name markers for the AI SDK's **chat** model spans. The SDK names them
 * `<wrapper>.<operation>` — `ai.streamText.doStream`, `ai.generateObject.doGenerate`
 * — so the operation is a name fragment, not a prefix.
 *
 * `doEmbed` (`ai.embed` / `ai.embedMany`) and `doRerank` (`ai.rerank`) are absent on
 * purpose: see {@link aiSdkSignalFilter}.
 */
const AI_SDK_CHAT_OPERATIONS = ["doGenerate", "doStream"] as const;

/** The AI SDK's tool-execution span; its attributes all sit under `ai.toolCall.*`. */
const AI_SDK_TOOL_CALL_SPAN = "ai.toolCall";

/**
 * Opt-in for the Vercel AI SDK's legacy `ai.*` telemetry — the chat model spans
 * (`ai.*.doGenerate` / `ai.*.doStream`) and the `ai.toolCall` span.
 *
 * These carry no `gen_ai.*` attribute of their own: the AI SDK still emits the
 * pre-semconv `ai.*` namespace, so {@link ratelSignalFilter}'s signal test alone
 * would never see them. Ratel Cloud normalizes `ai.*` into GenAI semconv on ingest,
 * which only works if the span leaves the process in the first place — hence this
 * predicate, matched to exactly the span shapes that normalizer understands.
 *
 * Two different exclusions, for two different reasons — both deliberate:
 *
 * - **Wrapper spans** (`ai.streamText`, `ai.generateText`, `ai.generateObject`, …)
 *   sit one level above and duplicate the entire prompt of the model span beneath
 *   them (~100 KB per call), so admitting them would roughly double egress;
 *   server-side they would mint a second anchor for one LLM call and double-count
 *   its tokens. Widening this to the whole `ai.` prefix is a bug, not a simplification.
 * - **Embedding and rerank spans** (`ai.embed.doEmbed`, `ai.embedMany.doEmbed`,
 *   `ai.rerank.doRerank`) are the wrong operation. Cloud's normalizer stamps
 *   `gen_ai.operation.name = "chat"` on every model span it accepts, so forwarding
 *   these would ingest embeddings as phantom chat completions — rows with no
 *   messages and no tools. Cloud has a distinct `"embeddings"` operation; turning it
 *   on is a feature decision, not a side effect of this filter.
 *
 * The `ai.` prefix is required, not decorative: an unanchored substring match would
 * admit any host span whose name happens to contain `doStream`, which is exactly the
 * co-tenancy violation this module exists to prevent.
 */
export function aiSdkSignalFilter(span: ReadableSpan): boolean {
  if (span.name === AI_SDK_TOOL_CALL_SPAN) return true;
  if (!span.name.startsWith(AI_SDK_SPAN_PREFIX)) return false;
  return AI_SDK_CHAT_OPERATIONS.some((operation) => span.name.includes(operation));
}

/**
 * Default span filter: forward only signal-bearing spans — a `ratel.*` span name,
 * any attribute key under `gen_ai.*` / `ratel.*`, or an AI SDK chat/tool span
 * ({@link aiSdkSignalFilter}).
 *
 * This is what lets Ratel share a provider with e.g. Langfuse + the Vercel AI SDK
 * and ingest only the gen_ai/ratel signal: the AI SDK's `gen_ai.*` spans plus
 * Ratel's own `ratel.search` / `execute_tool`.
 *
 * The AI SDK clause is a narrow, deliberate exception to "signal-bearing means
 * `gen_ai.*`". That SDK's telemetry predates the semconv and lives under `ai.*`;
 * Cloud translates it on ingest, so the spans are signal — they just don't say so in
 * a key. It admits `ai.toolCall` and the **chat model** spans
 * (`ai.*.doGenerate` / `ai.*.doStream`), and nothing else — see
 * {@link aiSdkSignalFilter} for why the `ai.streamText` / `ai.generateText` wrappers
 * and the embed/rerank spans each stay out for their own distinct reason. "`ai.*`
 * wrapper noise is dropped" still holds; what changed is that the model and tool
 * spans underneath it are no longer collateral damage.
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
  return aiSdkSignalFilter(span);
}
