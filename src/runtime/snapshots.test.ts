import { describe, expect, it, vi } from "vitest";
import { CatalogSnapshotsPublisher } from "./snapshots.js";

describe("CatalogSnapshotsPublisher", () => {
  it("PUTs the full source-scoped tool set without executors or secret-bearing fields", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return Response.json(
        { sourceId: "worker-a", catalogVersion: "version-1", tools: 1, unchanged: false },
        { headers: { ETag: '"version-1"' } },
      );
    }) as typeof fetch;
    const publisher = new CatalogSnapshotsPublisher({
      apiKey: "rtl_test",
      baseUrl: "https://cloud.test/api/v1/",
      fetch: fetchImpl,
    });
    const tool = {
      id: "weather.lookup",
      name: "weather.lookup",
      description: "Fetch a forecast.",
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
      metadata: { visibility: "public" },
      execute: () => "private result",
      apiKey: "secret-key",
      oauthToken: "secret-token",
    };

    publisher.publish({
      source_id: "worker-a",
      tools: [tool],
      skills: [{ id: "private-skill", body: "secret instructions" }],
    });
    await publisher.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://cloud.test/api/v1/catalog/snapshot");
    expect(requests[0]?.init).toMatchObject({
      method: "PUT",
      headers: {
        authorization: "Bearer rtl_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        source_id: "worker-a",
        tools: [
          {
            id: "weather.lookup",
            name: "weather.lookup",
            description: "Fetch a forecast.",
            input_schema: { type: "object" },
            output_schema: { type: "string" },
            metadata: { visibility: "public" },
          },
        ],
      }),
    });
    expect(String(requests[0]?.init?.body)).not.toMatch(
      /execute|secret-key|secret-token|private-skill|secret instructions/,
    );
  });

  it("debounces a churn burst into one full replacement containing the latest state", async () => {
    vi.useFakeTimers();
    const bodies: unknown[] = [];
    try {
      const publisher = new CatalogSnapshotsPublisher({
        apiKey: "rtl_test",
        debounceMs: 100,
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body)));
          return Response.json({}, { headers: { ETag: '"latest"' } });
        }) as typeof fetch,
      });

      publisher.publish({ source_id: "worker-a", tools: [tool("first")] });
      await vi.advanceTimersByTimeAsync(50);
      publisher.publish({ source_id: "worker-a", tools: [tool("first"), tool("second")] });
      await vi.advanceTimersByTimeAsync(99);
      expect(bodies).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      expect(bodies).toEqual([
        {
          source_id: "worker-a",
          tools: [wireTool("first"), wireTool("second")],
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a degraded 202 snapshot pending until Cloud confirms durable sync", async () => {
    let requests = 0;
    const publisher = new CatalogSnapshotsPublisher({
      apiKey: "rtl_test",
      fetch: (async () => {
        requests += 1;
        if (requests === 1) {
          return Response.json({ synced: false }, { status: 202 });
        }
        return Response.json({ synced: true }, { headers: { ETag: '"published"' } });
      }) as typeof fetch,
    });
    const snapshot = { source_id: "worker-a", tools: [tool("weather")] };

    publisher.publish(snapshot);
    await publisher.flush();
    await publisher.flush();
    publisher.publish(snapshot);
    await publisher.flush();

    expect(requests).toBe(2);
  });

  it("normalizes string limits and reports tools beyond the 5,000-tool cap", async () => {
    let body = "";
    const rejected: Array<{ eventId: string | null; reason: string }> = [];
    const tools = Array.from({ length: 5_001 }, (_, index) => tool(`tool-${index}`));
    tools[0] = {
      id: `  ${"i".repeat(600)}  `,
      name: `  ${"n".repeat(600)}  `,
      description: `  ${"d".repeat(20_000)}  `,
    };
    const publisher = new CatalogSnapshotsPublisher({
      apiKey: "rtl_test",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = String(init?.body);
        return Response.json({}, { headers: { ETag: '"published"' } });
      }) as typeof fetch,
      onRejected: (items) => rejected.push(...items),
    });

    publisher.publish({ source_id: "worker-a", tools });
    await publisher.flush();

    const request = JSON.parse(body) as {
      tools: Array<{ id: string; name: string; description: string }>;
    };
    expect(request.tools).toHaveLength(5_000);
    expect(request.tools[0]).toMatchObject({
      id: "i".repeat(512),
      name: "n".repeat(512),
      description: "d".repeat(16_384),
    });
    expect(rejected).toContainEqual({
      eventId: "tool-5000",
      reason: "catalog snapshot tool limit is 5000",
    });
  });

  it("skips and reports tools that cannot fit within the 4,000,000-byte body cap", async () => {
    let body = "";
    const rejected: Array<{ eventId: string | null; reason: string }> = [];
    const publisher = new CatalogSnapshotsPublisher({
      apiKey: "rtl_test",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = String(init?.body);
        return Response.json({}, { headers: { ETag: '"published"' } });
      }) as typeof fetch,
      onRejected: (items) => rejected.push(...items),
    });

    publisher.publish({
      source_id: "worker-a",
      tools: [{ ...tool("too-large"), metadata: { payload: "x".repeat(4_000_000) } }, tool("fits")],
    });
    await publisher.flush();

    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(4_000_000);
    expect((JSON.parse(body) as { tools: unknown[] }).tools).toEqual([wireTool("fits")]);
    expect(rejected).toContainEqual({
      eventId: "too-large",
      reason: "catalog snapshot tool cannot fit within 4000000 bytes",
    });
  });

  it("skips and reports tools made invalid by identifier normalization", async () => {
    let body = "";
    const rejected: Array<{ eventId: string | null; reason: string }> = [];
    const collidingPrefix = "x".repeat(512);
    const publisher = new CatalogSnapshotsPublisher({
      apiKey: "rtl_test",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = String(init?.body);
        return Response.json({}, { headers: { ETag: '"published"' } });
      }) as typeof fetch,
      onRejected: (items) => rejected.push(...items),
    });

    publisher.publish({
      source_id: "worker-a",
      tools: [
        { ...tool("blank-name"), name: "   " },
        { ...tool("fallback"), id: "   " },
        { ...tool(`${collidingPrefix}-one`), name: "first" },
        { ...tool(`${collidingPrefix}-two`), name: "second" },
      ],
    });
    await publisher.flush();

    expect((JSON.parse(body) as { tools: Array<{ id: string; name: string }> }).tools).toEqual([
      expect.objectContaining({ id: "fallback", name: "fallback" }),
      expect.objectContaining({ id: collidingPrefix, name: "first" }),
    ]);
    expect(rejected).toEqual([
      { eventId: "blank-name", reason: "catalog snapshot tool name is empty" },
      {
        eventId: `${collidingPrefix}-two`,
        reason: `catalog snapshot tool id is duplicated after normalization: ${collidingPrefix}`,
      },
    ]);
  });

  it("reports terminal snapshot HTTP failures without throwing", async () => {
    const rejected: Array<{ eventId: string | null; reason: string }> = [];
    const publisher = new CatalogSnapshotsPublisher({
      apiKey: "rtl_test",
      fetch: (async () => Response.json({ error: "malformed" }, { status: 400 })) as typeof fetch,
      onRejected: (items) => rejected.push(...items),
    });

    publisher.publish({ source_id: "worker-a", tools: [tool("weather")] });
    await expect(publisher.flush()).resolves.toBeUndefined();

    expect(rejected).toContainEqual({
      eventId: null,
      reason: "catalog snapshot for worker-a rejected with HTTP 400",
    });
  });

  it("reports exhausted snapshot delivery without throwing", async () => {
    const rejected: Array<{ eventId: string | null; reason: string }> = [];
    const publisher = new CatalogSnapshotsPublisher({
      apiKey: "rtl_test",
      fetch: (() => Promise.reject(new Error("offline"))) as typeof fetch,
      retry: { maxAttempts: 1 },
      onRejected: (items) => rejected.push(...items),
    });

    publisher.publish({ source_id: "worker-a", tools: [tool("weather")] });
    await expect(publisher.flush()).resolves.toBeUndefined();

    expect(rejected).toContainEqual({
      eventId: null,
      reason: "catalog snapshot for worker-a failed after retries",
    });
  });

  it("skips unchanged canonical hashes and publishes changed replacements unconditionally", async () => {
    const requests: RequestInit[] = [];
    const publisher = new CatalogSnapshotsPublisher({
      apiKey: "rtl_test",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(init ?? {});
        return Response.json({}, { headers: { ETag: `"server-version-${requests.length}"` } });
      }) as typeof fetch,
    });
    const first = {
      source_id: "worker-a",
      tools: [
        { ...tool("second"), inputSchema: { properties: { value: { type: "string" } } } },
        tool("first"),
      ],
    };

    publisher.publish(first);
    await publisher.flush();
    publisher.publish({
      source_id: "worker-a",
      tools: [
        tool("first"),
        { ...tool("second"), inputSchema: { properties: { value: { type: "string" } } } },
      ],
    });
    await publisher.flush();
    publisher.publish({ source_id: "worker-a", tools: [tool("first")] });
    await publisher.flush();

    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers).not.toHaveProperty("if-match");
    expect(requests[1]?.headers).not.toHaveProperty("if-match");
  });

  it("retries transient snapshot failures with exponential backoff", async () => {
    const sleeps: number[] = [];
    let requests = 0;
    const publisher = new CatalogSnapshotsPublisher({
      apiKey: "rtl_test",
      fetch: (async () => {
        requests += 1;
        if (requests === 1) throw new Error("socket closed");
        if (requests === 2) return Response.json({}, { status: 503 });
        return Response.json({}, { headers: { ETag: '"published"' } });
      }) as typeof fetch,
      retry: { maxAttempts: 3, initialBackoffMs: 100 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    publisher.publish({ source_id: "worker-a", tools: [tool("weather")] });
    await publisher.flush();

    expect(requests).toBe(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it("honors Retry-After when snapshot publication is rate limited", async () => {
    const sleeps: number[] = [];
    let requests = 0;
    const publisher = new CatalogSnapshotsPublisher({
      apiKey: "rtl_test",
      fetch: (async () => {
        requests += 1;
        if (requests === 1) {
          return Response.json({}, { status: 429, headers: { "Retry-After": "7" } });
        }
        return Response.json({}, { headers: { ETag: '"published"' } });
      }) as typeof fetch,
      retry: { maxAttempts: 2, initialBackoffMs: 100 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    publisher.publish({ source_id: "worker-a", tools: [] });
    await publisher.flush();

    expect(sleeps).toEqual([7_000]);
  });

  it("never throws malformed definitions or exhausted delivery failures into the caller", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const publisher = new CatalogSnapshotsPublisher({
      apiKey: "rtl_test",
      fetch: (() => Promise.reject(new Error("offline"))) as typeof fetch,
      retry: { maxAttempts: 2 },
      sleep: () => Promise.reject(new Error("timer failed")),
    });

    expect(() =>
      publisher.publish({
        source_id: "worker-a",
        tools: [{ ...tool("broken"), metadata: circular }],
      }),
    ).not.toThrow();
    expect(() =>
      publisher.publish({ source_id: "worker-a", tools: [tool("weather")] }),
    ).not.toThrow();
    await expect(publisher.flush()).resolves.toBeUndefined();
  });

  it("keeps each source's changed snapshot queued independently", async () => {
    const sources: string[] = [];
    const publisher = new CatalogSnapshotsPublisher({
      apiKey: "rtl_test",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { source_id: string };
        sources.push(body.source_id);
        return Response.json({}, { headers: { ETag: `"${body.source_id}-${sources.length}"` } });
      }) as typeof fetch,
    });

    publisher.publish({ source_id: "worker-b", tools: [tool("one")] });
    await publisher.flush();
    publisher.publish({ source_id: "worker-a", tools: [tool("one")] });
    publisher.publish({ source_id: "worker-b", tools: [tool("one")] });
    publisher.publish({ source_id: "worker-c", tools: [tool("one")] });
    await publisher.flush();

    expect(sources).toEqual(["worker-b", "worker-a", "worker-c"]);
  });

  it("serializes overlapping flushes before publishing replacements", async () => {
    const requests: RequestInit[] = [];
    let resolveFirst: ((response: Response) => void) | undefined;
    const publisher = new CatalogSnapshotsPublisher({
      apiKey: "rtl_test",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(init ?? {});
        if (requests.length === 1) {
          return await new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Response.json({}, { headers: { ETag: '"second"' } });
      }) as typeof fetch,
    });

    publisher.publish({ source_id: "worker-a", tools: [tool("one")] });
    const firstFlush = publisher.flush();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    publisher.publish({ source_id: "worker-a", tools: [tool("two")] });
    const secondFlush = publisher.flush();
    await Promise.resolve();

    expect(requests).toHaveLength(1);
    resolveFirst?.(Response.json({}, { headers: { ETag: '"first"' } }));
    await Promise.all([firstFlush, secondFlush]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers).not.toHaveProperty("if-match");
  });

  it("publishes a revert when a different snapshot is still in flight", async () => {
    const publishedToolIds: string[][] = [];
    let resolveIntermediate: ((response: Response) => void) | undefined;
    const publisher = new CatalogSnapshotsPublisher({
      apiKey: "rtl_test",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          tools: Array<{ id: string }>;
        };
        publishedToolIds.push(body.tools.map(({ id }) => id));
        if (publishedToolIds.length === 2) {
          return await new Promise<Response>((resolve) => {
            resolveIntermediate = resolve;
          });
        }
        return Response.json({}, { headers: { ETag: `"version-${publishedToolIds.length}"` } });
      }) as typeof fetch,
    });
    const acknowledged = { source_id: "worker-a", tools: [tool("one")] };

    publisher.publish(acknowledged);
    await publisher.flush();
    publisher.publish({ source_id: "worker-a", tools: [tool("two")] });
    const intermediateFlush = publisher.flush();
    await vi.waitFor(() => expect(publishedToolIds).toHaveLength(2));
    publisher.publish(acknowledged);
    resolveIntermediate?.(Response.json({}, { headers: { ETag: '"version-2"' } }));
    await intermediateFlush;

    expect(publishedToolIds).toEqual([["one"], ["two"], ["one"]]);
  });

  it("skips a queued snapshot when an identical in-flight replacement succeeds", async () => {
    let requests = 0;
    let resolveFirst: ((response: Response) => void) | undefined;
    const publisher = new CatalogSnapshotsPublisher({
      apiKey: "rtl_test",
      fetch: (async () => {
        requests += 1;
        if (requests === 1) {
          return await new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Response.json({}, { headers: { ETag: '"duplicate"' } });
      }) as typeof fetch,
    });
    const snapshot = { source_id: "worker-a", tools: [tool("one"), tool("two")] };

    publisher.publish(snapshot);
    const firstFlush = publisher.flush();
    await vi.waitFor(() => expect(requests).toBe(1));
    publisher.publish({ source_id: "worker-a", tools: [...snapshot.tools].reverse() });
    const secondFlush = publisher.flush();
    resolveFirst?.(Response.json({}, { headers: { ETag: '"first"' } }));
    await Promise.all([firstFlush, secondFlush]);

    expect(requests).toBe(1);
  });
});

function tool(id: string) {
  return { id, name: id, description: `${id} description` };
}

function wireTool(id: string) {
  return {
    id,
    name: id,
    description: `${id} description`,
    input_schema: null,
    output_schema: null,
    metadata: null,
  };
}
