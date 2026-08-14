import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../types.js";
import { RuntimeEventsPublisher } from "./publisher.js";

const EVENT: RuntimeEvent = {
  v: 2,
  event_id: "01J00000000000000000000000",
  ts: 1_750_000_000_000,
  session_id: "session-1",
  source_id: "worker-1",
  type: "invoke_start",
  invocation_id: "invocation-1",
  tool_id: "search_docs",
};

describe("RuntimeEventsPublisher", () => {
  it("publishes envelope-v2 events with bearer authentication", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return Response.json({ accepted: 1, duplicates: 0, rejected: [] }, { status: 202 });
    }) as typeof fetch;
    const publisher = new RuntimeEventsPublisher({
      apiKey: "rtl_test",
      baseUrl: "https://cloud.test/api/v1/",
      fetch: fetchImpl,
    });

    publisher.publish(EVENT);
    await expect(publisher.flush()).resolves.toBeUndefined();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://cloud.test/api/v1/events");
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer rtl_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ events: [EVENT] }),
    });
  });

  it("splits delivery at 5,000 events per batch", async () => {
    const batchSizes: number[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: RuntimeEvent[] };
      batchSizes.push(body.events.length);
      return Response.json(
        { accepted: body.events.length, duplicates: 0, rejected: [] },
        { status: 202 },
      );
    }) as typeof fetch;
    const publisher = new RuntimeEventsPublisher({
      apiKey: "rtl_test",
      fetch: fetchImpl,
      queueCapacity: 6_000,
    });

    for (let index = 0; index < 5_001; index += 1) {
      publisher.publish({ ...EVENT, event_id: `event-${index}` });
    }
    await publisher.flush();

    expect(batchSizes).toEqual([5_000, 1]);
  });

  it("keeps each serialized request body within the 3,900,000-byte client limit", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body);
      bodies.push(body);
      const { events } = JSON.parse(body) as { events: RuntimeEvent[] };
      return Response.json(
        { accepted: events.length, duplicates: 0, rejected: [] },
        { status: 202 },
      );
    }) as typeof fetch;
    const publisher = new RuntimeEventsPublisher({ apiKey: "rtl_test", fetch: fetchImpl });

    for (let index = 0; index < 70; index += 1) {
      publisher.publish({ ...EVENT, event_id: `event-${index}`, payload: "x".repeat(60_000) });
    }
    await publisher.flush();

    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.every((body) => new TextEncoder().encode(body).byteLength <= 3_900_000)).toBe(
      true,
    );
    expect(
      bodies.flatMap((body) => (JSON.parse(body) as { events: RuntimeEvent[] }).events),
    ).toHaveLength(70);
  });

  it("surfaces partial-success rejections without retrying them", async () => {
    let requests = 0;
    const rejected: Array<{ eventId: string | null; reason: string }> = [];
    const fetchImpl = (async () => {
      requests += 1;
      return Response.json(
        {
          accepted: 0,
          duplicates: 0,
          rejected: [{ index: 0, event_id: EVENT.event_id, reason: "invalid event" }],
        },
        { status: 202 },
      );
    }) as typeof fetch;
    const publisher = new RuntimeEventsPublisher({
      apiKey: "rtl_test",
      fetch: fetchImpl,
      onRejected: (items) => rejected.push(...items),
    });

    publisher.publish(EVENT);
    await publisher.flush();
    await publisher.flush();

    expect(rejected).toEqual([{ eventId: EVENT.event_id, reason: "invalid event" }]);
    expect(requests).toBe(1);
  });

  it("reports every event dropped by a non-retryable batch failure", async () => {
    const rejected: Array<{ eventId: string | null; reason: string }> = [];
    const publisher = new RuntimeEventsPublisher({
      apiKey: "rtl_test",
      fetch: (async () =>
        Response.json({ error: "payload too large" }, { status: 413 })) as typeof fetch,
      onRejected: (items) => rejected.push(...items),
    });

    publisher.publish({ ...EVENT, event_id: "event-1" });
    publisher.publish({ ...EVENT, event_id: "event-2" });
    await publisher.flush();

    expect(rejected).toEqual([
      { eventId: "event-1", reason: "batch rejected with HTTP 413" },
      { eventId: "event-2", reason: "batch rejected with HTTP 413" },
    ]);
  });

  it("reports every event dropped after delivery retries are exhausted", async () => {
    const rejected: Array<{ eventId: string | null; reason: string }> = [];
    const publisher = new RuntimeEventsPublisher({
      apiKey: "rtl_test",
      fetch: (() => Promise.reject(new Error("offline"))) as typeof fetch,
      retry: { maxAttempts: 1 },
      onRejected: (items) => rejected.push(...items),
    });

    publisher.publish({ ...EVENT, event_id: "event-1" });
    await publisher.flush();

    expect(rejected).toEqual([
      { eventId: "event-1", reason: "batch delivery failed after retries" },
    ]);
  });

  it("does not retry a successful response without a JSON body", async () => {
    let requests = 0;
    const publisher = new RuntimeEventsPublisher({
      apiKey: "rtl_test",
      fetch: (async () => {
        requests += 1;
        return new Response(null, { status: 204 });
      }) as typeof fetch,
      retry: { maxAttempts: 3, initialBackoffMs: 0 },
    });

    publisher.publish(EVENT);
    await publisher.flush();

    expect(requests).toBe(1);
  });

  it("retries transient failures with exponential backoff", async () => {
    const sleeps: number[] = [];
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      if (requests === 1) throw new Error("socket closed");
      if (requests === 2) return Response.json({ error: "unavailable" }, { status: 503 });
      return Response.json({ accepted: 1, duplicates: 0, rejected: [] }, { status: 202 });
    }) as typeof fetch;
    const publisher = new RuntimeEventsPublisher({
      apiKey: "rtl_test",
      fetch: fetchImpl,
      retry: { maxAttempts: 3, initialBackoffMs: 100 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    publisher.publish(EVENT);
    await publisher.flush();

    expect(requests).toBe(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it("honors Retry-After on rate limits", async () => {
    const sleeps: number[] = [];
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      if (requests === 1) {
        return Response.json(
          { error: "rate limited" },
          { status: 429, headers: { "Retry-After": "7" } },
        );
      }
      return Response.json({ accepted: 1, duplicates: 0, rejected: [] }, { status: 202 });
    }) as typeof fetch;
    const publisher = new RuntimeEventsPublisher({
      apiKey: "rtl_test",
      fetch: fetchImpl,
      retry: { maxAttempts: 2, initialBackoffMs: 100 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    publisher.publish(EVENT);
    await publisher.flush();

    expect(sleeps).toEqual([7_000]);
  });

  it("does not enqueue or send when RATEL_CLOUD_EVENTS is off", async () => {
    const previous = process.env.RATEL_CLOUD_EVENTS;
    process.env.RATEL_CLOUD_EVENTS = "off";
    let requests = 0;
    try {
      const publisher = new RuntimeEventsPublisher({
        apiKey: "rtl_test",
        fetch: (async () => {
          requests += 1;
          return Response.json({}, { status: 202 });
        }) as typeof fetch,
      });

      publisher.publish(EVENT);
      await publisher.flush();

      expect(requests).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.RATEL_CLOUD_EVENTS;
      else process.env.RATEL_CLOUD_EVENTS = previous;
    }
  });

  it("drops the oldest queued event on overflow and emits events_dropped", async () => {
    const delivered: RuntimeEvent[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: RuntimeEvent[] };
      delivered.push(...body.events);
      return Response.json(
        { accepted: body.events.length, duplicates: 0, rejected: [] },
        { status: 202 },
      );
    }) as typeof fetch;
    const publisher = new RuntimeEventsPublisher({
      apiKey: "rtl_test",
      fetch: fetchImpl,
      queueCapacity: 2,
    });

    publisher.publish({ ...EVENT, event_id: "event-1", ts: 101 });
    publisher.publish({ ...EVENT, event_id: "event-2", ts: 102 });
    publisher.publish({ ...EVENT, event_id: "event-3", ts: 103 });
    await publisher.flush();

    expect(delivered.map((event) => event.event_id)).not.toContain("event-1");
    expect(delivered.map((event) => event.event_id)).toEqual([
      "event-2",
      "event-3",
      expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    ]);
    expect(delivered[2]).toMatchObject({
      v: 2,
      session_id: EVENT.session_id,
      source_id: EVENT.source_id,
      type: "events_dropped",
      dropped_count: 1,
      reason: "queue_overflow",
      window_start_ts: 101,
      window_end_ts: 101,
    });
  });

  it("attributes overflow ledgers to each dropped event's source and session", async () => {
    const delivered: RuntimeEvent[] = [];
    const publisher = new RuntimeEventsPublisher({
      apiKey: "rtl_test",
      queueCapacity: 2,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { events: RuntimeEvent[] };
        delivered.push(...body.events);
        return Response.json(
          { accepted: body.events.length, duplicates: 0, rejected: [] },
          { status: 202 },
        );
      }) as typeof fetch,
    });

    publisher.publish({ ...EVENT, event_id: "dropped-a", source_id: "a", session_id: "one" });
    publisher.publish({ ...EVENT, event_id: "dropped-b", source_id: "b", session_id: "two" });
    publisher.publish({ ...EVENT, event_id: "kept-c" });
    publisher.publish({ ...EVENT, event_id: "kept-d" });
    await publisher.flush();

    expect(delivered.filter((event) => event.type === "events_dropped")).toEqual([
      expect.objectContaining({ source_id: "a", session_id: "one", dropped_count: 1 }),
      expect.objectContaining({ source_id: "b", session_id: "two", dropped_count: 1 }),
    ]);
  });

  it("bounds overflow ledger cardinality by the queue capacity", async () => {
    const delivered: RuntimeEvent[] = [];
    const publisher = new RuntimeEventsPublisher({
      apiKey: "rtl_test",
      queueCapacity: 2,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { events: RuntimeEvent[] };
        delivered.push(...body.events);
        return Response.json(
          { accepted: body.events.length, duplicates: 0, rejected: [] },
          { status: 202 },
        );
      }) as typeof fetch,
    });

    for (let index = 0; index < 100; index += 1) {
      publisher.publish({
        ...EVENT,
        event_id: `event-${index}`,
        session_id: `session-${index}`,
      });
    }
    await publisher.flush();

    const ledgers = delivered.filter((event) => event.type === "events_dropped");
    expect(ledgers).toHaveLength(2);
    expect(ledgers.every((event) => typeof event.dropped_count === "number")).toBe(true);
    expect(
      ledgers.reduce(
        (count, event) =>
          count + (typeof event.dropped_count === "number" ? event.dropped_count : 0),
        0,
      ),
    ).toBe(98);
    expect(delivered).toHaveLength(4);
  });

  it("rejects an event over 64 KiB locally without sinking valid events", async () => {
    const delivered: RuntimeEvent[] = [];
    const rejected: Array<{ eventId: string | null; reason: string }> = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: RuntimeEvent[] };
      delivered.push(...body.events);
      return Response.json(
        { accepted: body.events.length, duplicates: 0, rejected: [] },
        { status: 202 },
      );
    }) as typeof fetch;
    const publisher = new RuntimeEventsPublisher({
      apiKey: "rtl_test",
      fetch: fetchImpl,
      onRejected: (items) => rejected.push(...items),
    });

    publisher.publish({ ...EVENT, event_id: "too-big", payload: "x".repeat(65_536) });
    publisher.publish({ ...EVENT, event_id: "valid" });
    await publisher.flush();

    expect(delivered.map((event) => event.event_id)).toEqual(["valid"]);
    expect(rejected).toEqual([
      { eventId: "too-big", reason: "serialized event exceeds 65536 bytes" },
    ]);
  });

  it("drains queued events asynchronously without an explicit flush", async () => {
    vi.useFakeTimers();
    let requests = 0;
    try {
      const publisher = new RuntimeEventsPublisher({
        apiKey: "rtl_test",
        flushIntervalMs: 10,
        fetch: (async () => {
          requests += 1;
          return Response.json({ accepted: 1, duplicates: 0, rejected: [] }, { status: 202 });
        }) as typeof fetch,
      });

      publisher.publish(EVENT);
      expect(requests).toBe(0);
      await vi.advanceTimersByTimeAsync(10);

      expect(requests).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never throws fetch, serialization, timer, or callback failures into the caller", async () => {
    const circular = { ...EVENT, event_id: "circular" } as RuntimeEvent & {
      circular?: unknown;
    };
    circular.circular = circular;
    const publisher = new RuntimeEventsPublisher({
      apiKey: "rtl_test",
      fetch: (() => Promise.reject(new Error("offline"))) as typeof fetch,
      retry: { maxAttempts: 2 },
      sleep: () => Promise.reject(new Error("timer failed")),
      onRejected: () => {
        throw new Error("callback failed");
      },
    });

    expect(() => publisher.publish(circular)).not.toThrow();
    expect(() => publisher.publish(EVENT)).not.toThrow();
    await expect(publisher.flush()).resolves.toBeUndefined();
  });
});
