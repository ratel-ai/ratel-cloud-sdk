import { context, propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import { EXPERIMENT_BAGGAGE_PREFIX, RatelSpanProcessor } from "./processor.js";

/**
 * A host-owned provider with the Ratel processor as a tenant — the only wiring the
 * package supports. `BasicTracerProvider` fans out identically to `NodeTracerProvider`
 * and needs no extra dependency.
 */
function hostProvider(processor: RatelSpanProcessor) {
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  return { provider, tracer: provider.getTracer("test") };
}

/** Emit one span through a real provider so the processor sees a genuine ReadableSpan. */
async function emit(
  processor: RatelSpanProcessor,
  name: string,
  attributes: Record<string, string> = {},
) {
  const { provider, tracer } = hostProvider(processor);
  tracer.startSpan(name, { attributes }).end();
  await provider.forceFlush();
}

describe("RatelSpanProcessor — signal filtering", () => {
  it("forwards signal-bearing spans to the exporter", async () => {
    const exporter = new InMemorySpanExporter();
    await emit(new RatelSpanProcessor({ exporter }), "ratel.search");
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["ratel.search"]);
  });

  it("drops the host's framework noise before it leaves the process", async () => {
    const exporter = new InMemorySpanExporter();
    await emit(new RatelSpanProcessor({ exporter }), "ai.generateText");
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("forwards the AI SDK's chat and tool spans, not its wrappers or embeddings", async () => {
    const exporter = new InMemorySpanExporter();
    const processor = new RatelSpanProcessor({ exporter });
    const { provider, tracer } = hostProvider(processor);
    tracer.startSpan("ai.streamText", { attributes: { "ai.model.id": "gpt-4" } }).end();
    tracer.startSpan("ai.streamText.doStream", { attributes: { "ai.model.id": "gpt-4" } }).end();
    tracer.startSpan("ai.toolCall", { attributes: { "ai.toolCall.name": "lookup" } }).end();
    tracer.startSpan("ai.embed.doEmbed", { attributes: { "ai.model.id": "text-embed-3" } }).end();
    await provider.forceFlush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual([
      "ai.streamText.doStream",
      "ai.toolCall",
    ]);
  });

  it("forwards a foreign-named span that carries gen_ai.* attributes", async () => {
    const exporter = new InMemorySpanExporter();
    await emit(new RatelSpanProcessor({ exporter }), "execute_tool lookup", {
      "gen_ai.tool.name": "lookup",
    });
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  it("honours a per-instance filter override", async () => {
    const exporter = new InMemorySpanExporter();
    await emit(new RatelSpanProcessor({ exporter, spanFilter: () => true }), "ai.generateText");
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["ai.generateText"]);
  });

  it("can be narrowed as well as widened", async () => {
    const exporter = new InMemorySpanExporter();
    const processor = new RatelSpanProcessor({ exporter, spanFilter: (s) => s.name === "keep" });
    const { provider, tracer } = hostProvider(processor);
    tracer.startSpan("keep").end();
    tracer.startSpan("ratel.search").end(); // would pass the default filter
    await provider.forceFlush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["keep"]);
  });
});

describe("RatelSpanProcessor — enabled: false", () => {
  it("exports nothing", async () => {
    const exporter = new InMemorySpanExporter();
    await emit(new RatelSpanProcessor({ exporter, enabled: false }), "ratel.search");
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("constructs without resolving endpoint or auth at all", () => {
    // No apiKey, no exporter, and an endpoint that would be nonsense to export to:
    // a disabled processor must not care, because it resolves nothing.
    expect(() => new RatelSpanProcessor({ enabled: false })).not.toThrow();
  });

  it("keeps forceFlush and shutdown resolvable", async () => {
    const processor = new RatelSpanProcessor({ enabled: false });
    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });

  it("does not stamp experiment baggage", async () => {
    const exporter = new InMemorySpanExporter();
    const processor = new RatelSpanProcessor({ exporter, enabled: false, spanFilter: () => true });
    const { provider, tracer } = hostProvider(processor);
    const ctx = propagation.setBaggage(
      ROOT_CONTEXT,
      propagation.createBaggage({ [`${EXPERIMENT_BAGGAGE_PREFIX}arm`]: { value: "b" } }),
    );
    tracer.startSpan("ratel.search", {}, ctx).end();
    await provider.forceFlush();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("RatelSpanProcessor — experiment baggage stamping", () => {
  const withBaggage = (entries: Record<string, string>) =>
    propagation.setBaggage(
      ROOT_CONTEXT,
      propagation.createBaggage(
        Object.fromEntries(Object.entries(entries).map(([k, value]) => [k, { value }])),
      ),
    );

  it("copies ratel.experiment.* baggage onto the span as attributes", async () => {
    const exporter = new InMemorySpanExporter();
    const { provider, tracer } = hostProvider(new RatelSpanProcessor({ exporter }));
    const ctx = withBaggage({
      "ratel.experiment.name": "retrieval-v2",
      "ratel.experiment.arm": "treatment",
    });
    tracer.startSpan("ratel.search", {}, ctx).end();
    await provider.forceFlush();

    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes).toMatchObject({
      "ratel.experiment.name": "retrieval-v2",
      "ratel.experiment.arm": "treatment",
    });
  });

  it("copies nothing but the experiment namespace", async () => {
    const exporter = new InMemorySpanExporter();
    const { provider, tracer } = hostProvider(new RatelSpanProcessor({ exporter }));
    const ctx = withBaggage({ "ratel.experiment.arm": "a", "session.id": "s-1", other: "x" });
    tracer.startSpan("ratel.search", {}, ctx).end();
    await provider.forceFlush();

    const attributes = exporter.getFinishedSpans()[0]?.attributes ?? {};
    expect(attributes["ratel.experiment.arm"]).toBe("a");
    expect(attributes["session.id"]).toBeUndefined();
    expect(attributes.other).toBeUndefined();
  });

  it("is a no-op when the host context carries no baggage", async () => {
    const exporter = new InMemorySpanExporter();
    await emit(new RatelSpanProcessor({ exporter }), "ratel.search");
    const attributes = exporter.getFinishedSpans()[0]?.attributes ?? {};
    expect(Object.keys(attributes)).toHaveLength(0);
  });

  it("never registers or replaces the host's ContextManager", () => {
    const setGlobal = vi.spyOn(context, "setGlobalContextManager");
    const processor = new RatelSpanProcessor({ exporter: new InMemorySpanExporter() });
    const { tracer } = hostProvider(processor);
    tracer.startSpan("ratel.search").end();
    expect(setGlobal).not.toHaveBeenCalled();
    setGlobal.mockRestore();
  });

  it("never registers a global tracer provider", () => {
    const setGlobal = vi.spyOn(trace, "setGlobalTracerProvider");
    void new RatelSpanProcessor({ exporter: new InMemorySpanExporter() });
    expect(setGlobal).not.toHaveBeenCalled();
    setGlobal.mockRestore();
  });
});
