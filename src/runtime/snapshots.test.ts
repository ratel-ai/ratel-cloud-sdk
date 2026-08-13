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

  it("skips unchanged canonical hashes and guards changed replacements with If-Match", async () => {
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
    expect(requests[1]?.headers).toMatchObject({ "if-match": '"server-version-1"' });
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

  it("keeps conditional replacement state scoped to each source id", async () => {
    const requests: RequestInit[] = [];
    const publisher = new CatalogSnapshotsPublisher({
      apiKey: "rtl_test",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(init ?? {});
        return Response.json({}, { headers: { ETag: `"source-${requests.length}"` } });
      }) as typeof fetch,
    });

    publisher.publish({ source_id: "worker-a", tools: [tool("one")] });
    await publisher.flush();
    publisher.publish({ source_id: "worker-b", tools: [tool("one")] });
    await publisher.flush();
    publisher.publish({ source_id: "worker-a", tools: [tool("two")] });
    await publisher.flush();

    expect(requests[0]?.headers).not.toHaveProperty("if-match");
    expect(requests[1]?.headers).not.toHaveProperty("if-match");
    expect(requests[2]?.headers).toMatchObject({ "if-match": '"source-1"' });
  });

  it("serializes overlapping flushes so replacements use the latest ETag", async () => {
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
    expect(requests[1]?.headers).toMatchObject({ "if-match": '"first"' });
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
