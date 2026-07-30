/**
 * The Phase E signal-filter proof: Ratel Cloud as one tenant among several on a
 * provider the host owns.
 *
 * RS-43 built the generic coexistence suite deliberately without any Ratel Cloud
 * surface; the filter proof was held back to this package so the OSS emit side
 * could be proven against third-party backends first. This is that proof.
 *
 * No network: every destination is an in-memory exporter. The vendor side is a
 * hand-written predicate wrapper rather than a real vendor processor — `@langfuse/otel`
 * is not a dependency here, and the shape of the check is what matters.
 */

import type { Context } from "@opentelemetry/api";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { EXPERIMENT_BAGGAGE_PREFIX, RatelSpanProcessor } from "./processor.js";

/**
 * A stand-in for a vendor processor that applies its own export filter — the shape
 * of `LangfuseSpanProcessor`'s `shouldExportSpan`. Its default behaviour mirrors the
 * finding from Phase C: keep only spans carrying `gen_ai.*`, which silently drops
 * most of the SDK's own `ratel.*` spans.
 */
function vendorProcessor(
  exporter: InMemorySpanExporter,
  shouldExport: (span: ReadableSpan) => boolean = (span) =>
    Object.keys(span.attributes).some((k) => k.startsWith("gen_ai.")),
): SpanProcessor {
  const inner = new SimpleSpanProcessor(exporter);
  return {
    onStart: (span: Span, ctx: Context) => inner.onStart(span, ctx),
    onEnd: (span) => {
      if (shouldExport(span)) inner.onEnd(span);
    },
    forceFlush: () => inner.forceFlush(),
    shutdown: () => inner.shutdown(),
  };
}

/** A host provider running Ratel alongside a vendor and an unfiltered sink. */
function host(ratel: RatelSpanProcessor) {
  const vendor = new InMemorySpanExporter();
  const everything = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [ratel, vendorProcessor(vendor), new SimpleSpanProcessor(everything)],
  });
  return { provider, tracer: provider.getTracer("host"), vendor, everything };
}

/** The span shapes the SDK and the AI SDK put on a shared provider. */
const STREAM: Array<[string, Record<string, string>]> = [
  ["ratel.search", {}],
  ["ratel.skill.load", {}],
  ["execute_tool lookup", { "gen_ai.tool.name": "lookup" }],
  ["ai.generateText", { "ai.model.id": "gpt-4" }],
  ["ai.generateText.doGenerate", { "ai.model.id": "gpt-4" }],
  ["ai.toolCall", { "ai.toolCall.name": "lookup" }],
  ["ai.embed.doEmbed", { "ai.model.id": "text-embed-3" }],
  ["GET /health", { "http.method": "GET" }],
];

describe("Ratel Cloud as a co-tenant on a host-owned provider", () => {
  it("receives the gen_ai/ratel signal while the host's own sink still sees everything", async () => {
    const cloud = new InMemorySpanExporter();
    const { provider, tracer, everything } = host(new RatelSpanProcessor({ exporter: cloud }));
    for (const [name, attributes] of STREAM) tracer.startSpan(name, { attributes }).end();
    await provider.forceFlush();

    // Emission is shared and lossless: the unfiltered sink sees the whole stream.
    expect(everything.getFinishedSpans()).toHaveLength(STREAM.length);
    // Delivery is per-destination: Ratel takes only the signal — plus the AI SDK's
    // legacy chat/tool spans, which Cloud normalizes into gen_ai.* on ingest. The
    // `ai.generateText` wrapper (a duplicate of the prompt below it) and the embedding
    // span (which Cloud would read as a chat completion) both stay out.
    expect(cloud.getFinishedSpans().map((s) => s.name)).toEqual([
      "ratel.search",
      "ratel.skill.load",
      "execute_tool lookup",
      "ai.generateText.doGenerate",
      "ai.toolCall",
    ]);
  });

  it("still ingests ratel.* spans that a stock vendor filter drops", async () => {
    const cloud = new InMemorySpanExporter();
    const { provider, tracer, vendor } = host(new RatelSpanProcessor({ exporter: cloud }));
    for (const [name, attributes] of STREAM) tracer.startSpan(name, { attributes }).end();
    await provider.forceFlush();

    const vendorNames = vendor.getFinishedSpans().map((s) => s.name);
    const cloudNames = cloud.getFinishedSpans().map((s) => s.name);
    // The vendor keeps only the gen_ai.*-tagged span — ratel.search / ratel.skill.load
    // arrive at its processor and are dropped there, not at the source.
    expect(vendorNames).toEqual(["execute_tool lookup"]);
    expect(cloudNames).toContain("ratel.search");
    expect(cloudNames).toContain("ratel.skill.load");
  });

  it("leaves the host's destinations untouched when disabled", async () => {
    const cloud = new InMemorySpanExporter();
    const { provider, tracer, vendor, everything } = host(
      new RatelSpanProcessor({ exporter: cloud, enabled: false }),
    );
    for (const [name, attributes] of STREAM) tracer.startSpan(name, { attributes }).end();
    await provider.forceFlush();

    expect(cloud.getFinishedSpans()).toHaveLength(0);
    expect(vendor.getFinishedSpans()).toHaveLength(1);
    expect(everything.getFinishedSpans()).toHaveLength(STREAM.length);
  });
});

describe("trace correlation", () => {
  it("joins ratel.* and gen_ai.* spans under an active host span", async () => {
    const cloud = new InMemorySpanExporter();
    const { provider, tracer } = host(new RatelSpanProcessor({ exporter: cloud }));

    const operation = tracer.startSpan("host.operation");
    const ctx = trace.setSpan(ROOT_CONTEXT, operation);
    tracer.startSpan("ratel.search", {}, ctx).end();
    tracer.startSpan("execute_tool lookup", { attributes: { "gen_ai.tool.name": "l" } }, ctx).end();
    operation.end();
    await provider.forceFlush();

    const traceIds = new Set(cloud.getFinishedSpans().map((s) => s.spanContext().traceId));
    expect(cloud.getFinishedSpans()).toHaveLength(2);
    expect(traceIds.size).toBe(1);
    expect([...traceIds][0]).toBe(operation.spanContext().traceId);
  });

  it("produces separate root traces without one — the uninstrumented-entrypoint trap", async () => {
    const cloud = new InMemorySpanExporter();
    const { provider, tracer } = host(new RatelSpanProcessor({ exporter: cloud }));
    tracer.startSpan("ratel.search").end();
    tracer.startSpan("ratel.skill.load").end();
    await provider.forceFlush();

    const traceIds = new Set(cloud.getFinishedSpans().map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(2);
  });
});

describe("experiment stamping is visible to every tenant", () => {
  it("stamps ratel.experiment.* onto the shared span, not just Ratel's copy", async () => {
    const cloud = new InMemorySpanExporter();
    const { provider, tracer, everything } = host(new RatelSpanProcessor({ exporter: cloud }));

    const { propagation } = await import("@opentelemetry/api");
    const ctx = propagation.setBaggage(
      ROOT_CONTEXT,
      propagation.createBaggage({ [`${EXPERIMENT_BAGGAGE_PREFIX}arm`]: { value: "treatment" } }),
    );
    tracer.startSpan("ratel.search", {}, ctx).end();
    await provider.forceFlush();

    // Documented cross-tenant effect: onStart mutates the span itself, so the host's
    // other destinations see the arm attribute too. That is what makes RS-33 arm
    // stamping framework-agnostic — and why it is worth stating out loud.
    expect(everything.getFinishedSpans()[0]?.attributes[`${EXPERIMENT_BAGGAGE_PREFIX}arm`]).toBe(
      "treatment",
    );
    expect(cloud.getFinishedSpans()[0]?.attributes[`${EXPERIMENT_BAGGAGE_PREFIX}arm`]).toBe(
      "treatment",
    );
  });
});
