import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { aiSdkSignalFilter, ratelSignalFilter } from "./filters.js";

/** Only the two fields the predicate reads; the rest of ReadableSpan is irrelevant here. */
function span(name: string, attributes: Record<string, unknown> = {}): ReadableSpan {
  return { name, attributes } as unknown as ReadableSpan;
}

describe("ratelSignalFilter", () => {
  it("keeps spans the SDK names under ratel.*", () => {
    expect(ratelSignalFilter(span("ratel.search"))).toBe(true);
    expect(ratelSignalFilter(span("ratel.skill.load"))).toBe(true);
    expect(ratelSignalFilter(span("ratel.upstream.register"))).toBe(true);
    expect(ratelSignalFilter(span("ratel.auth.flow"))).toBe(true);
  });

  it("keeps any span carrying a gen_ai.* attribute, whoever emitted it", () => {
    expect(ratelSignalFilter(span("execute_tool lookup", { "gen_ai.tool.name": "lookup" }))).toBe(
      true,
    );
    expect(ratelSignalFilter(span("chat gpt-4", { "gen_ai.system": "openai" }))).toBe(true);
  });

  it("keeps a span carrying a ratel.* attribute under a foreign name", () => {
    expect(ratelSignalFilter(span("POST /invoke", { "ratel.origin": "catalog" }))).toBe(true);
  });

  it("drops the host framework's wrapper noise", () => {
    expect(ratelSignalFilter(span("ai.generateText"))).toBe(false);
    expect(ratelSignalFilter(span("ai.streamText", { "ai.prompt.messages": "[…]" }))).toBe(false);
    expect(ratelSignalFilter(span("GET /health", { "http.method": "GET" }))).toBe(false);
  });

  it("keeps the AI SDK's legacy ai.* chat and tool spans for Cloud to normalize", () => {
    expect(ratelSignalFilter(span("ai.toolCall", { "ai.toolCall.name": "lookup" }))).toBe(true);
    expect(ratelSignalFilter(span("ai.streamText.doStream", { "ai.model.id": "gpt-4" }))).toBe(
      true,
    );
    expect(ratelSignalFilter(span("ai.generateText.doGenerate", { "ai.model.id": "gpt-4" }))).toBe(
      true,
    );
  });

  it("still drops the AI SDK's embedding and rerank spans", () => {
    // Cloud stamps gen_ai.operation.name = "chat" on every model span it accepts;
    // these would land as phantom chat completions with no messages.
    expect(ratelSignalFilter(span("ai.embed.doEmbed", { "ai.model.id": "text-embed-3" }))).toBe(
      false,
    );
    expect(ratelSignalFilter(span("ai.embedMany.doEmbed", { "ai.model.id": "text-embed-3" }))).toBe(
      false,
    );
    expect(ratelSignalFilter(span("ai.rerank.doRerank", { "ai.model.id": "rerank-3" }))).toBe(
      false,
    );
  });

  it("still keeps a wrapper span that does carry gen_ai.* attributes", () => {
    // The signal test runs first and is untouched by the ai.* clause.
    expect(ratelSignalFilter(span("ai.streamText", { "gen_ai.system": "openai" }))).toBe(true);
    expect(ratelSignalFilter(span("ai.generateText", { "gen_ai.request.model": "gpt-4" }))).toBe(
      true,
    );
  });

  it("does not match on a bare prefix collision", () => {
    // "ratelize" is not "ratel." — the dot is part of the namespace.
    expect(ratelSignalFilter(span("ratelize"))).toBe(false);
    expect(ratelSignalFilter(span("work", { ratelized: "yes" }))).toBe(false);
  });

  it("drops a span with no attributes and a foreign name", () => {
    expect(ratelSignalFilter(span("anonymous"))).toBe(false);
  });
});

describe("aiSdkSignalFilter", () => {
  it("admits the tool-execution span", () => {
    expect(aiSdkSignalFilter(span("ai.toolCall"))).toBe(true);
  });

  it("admits every chat model span the AI SDK emits", () => {
    expect(aiSdkSignalFilter(span("ai.generateText.doGenerate"))).toBe(true);
    expect(aiSdkSignalFilter(span("ai.streamText.doStream"))).toBe(true);
    expect(aiSdkSignalFilter(span("ai.generateObject.doGenerate"))).toBe(true);
    expect(aiSdkSignalFilter(span("ai.streamObject.doStream"))).toBe(true);
  });

  it("rejects the wrapper spans that duplicate the model span's prompt", () => {
    expect(aiSdkSignalFilter(span("ai.streamText"))).toBe(false);
    expect(aiSdkSignalFilter(span("ai.generateText"))).toBe(false);
    expect(aiSdkSignalFilter(span("ai.generateObject"))).toBe(false);
    expect(aiSdkSignalFilter(span("ai.streamObject"))).toBe(false);
    expect(aiSdkSignalFilter(span("ai.embed"))).toBe(false);
  });

  it("rejects embedding and rerank spans — wrong operation, not wrong shape", () => {
    // Cloud's normalizer stamps gen_ai.operation.name = "chat" on what it accepts,
    // so these would ingest as chat completions with no messages and no tools. Its
    // "embeddings" operation exists; sending them there is a feature, not a side effect.
    expect(aiSdkSignalFilter(span("ai.embed.doEmbed"))).toBe(false);
    expect(aiSdkSignalFilter(span("ai.embedMany.doEmbed"))).toBe(false);
    expect(aiSdkSignalFilter(span("ai.rerank.doRerank"))).toBe(false);
  });

  it("anchors on the ai. prefix — a foreign span merely containing an operation is out", () => {
    // An unanchored substring match would let any co-tenant's span in.
    expect(aiSdkSignalFilter(span("myapp.doStreamThing"))).toBe(false);
    expect(aiSdkSignalFilter(span("worker.doGenerate"))).toBe(false);
    expect(aiSdkSignalFilter(span("aircraft.doStream"))).toBe(false);
  });

  it("reads only the span name — attributes never opt a span in here", () => {
    expect(aiSdkSignalFilter(span("ai.streamText", { "ai.prompt.messages": "[…]" }))).toBe(false);
    expect(aiSdkSignalFilter(span("ai.toolCall.result"))).toBe(false);
  });

  it("leaves everything outside the AI SDK's span shapes alone", () => {
    expect(aiSdkSignalFilter(span("ratel.search"))).toBe(false);
    expect(aiSdkSignalFilter(span("GET /health", { "http.method": "GET" }))).toBe(false);
    expect(aiSdkSignalFilter(span("execute_tool lookup", { "gen_ai.tool.name": "l" }))).toBe(false);
  });
});
