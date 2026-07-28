import type { SdkLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { ratelEventFilter, ratelSignalFilter } from "./filters.js";

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
    expect(ratelSignalFilter(span("ai.streamText.doStream", { "ai.model.id": "gpt-4" }))).toBe(
      false,
    );
    expect(ratelSignalFilter(span("GET /health", { "http.method": "GET" }))).toBe(false);
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

describe("ratelEventFilter", () => {
  const record = (eventName?: string) => ({ eventName }) as SdkLogRecord;

  it("keeps gen_ai.* and ratel.* EventRecords", () => {
    expect(ratelEventFilter(record("gen_ai.client.inference.operation.details"))).toBe(true);
    expect(ratelEventFilter(record("ratel.skill.selected"))).toBe(true);
  });

  it("drops foreign and unnamed records", () => {
    expect(ratelEventFilter(record("app.user.login"))).toBe(false);
    expect(ratelEventFilter(record(undefined))).toBe(false);
  });
});
