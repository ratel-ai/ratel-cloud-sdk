import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../types.js";

// `@ratel-ai/sdk` ships a native IntentGraph whose internal rev only moves
// through its own usage-recording API. Mocking it keeps this suite fast,
// deterministic, and independent of the native binary — the module under
// test only ever calls `new IntentGraph()`, `IntentGraph.fromJson`,
// `.toJson()`, and `.rev`, all reproduced here, plus a test-only `bumpRev`.
vi.mock("@ratel-ai/sdk", () => {
  class FakeIntentGraph {
    #rev: number;
    #clusters: unknown[];

    constructor(rev = 0, clusters: unknown[] = []) {
      this.#rev = rev;
      this.#clusters = clusters;
    }

    static fromJson(json: string): FakeIntentGraph {
      const parsed = JSON.parse(json) as { rev?: number; clusters?: unknown[] };
      return new FakeIntentGraph(parsed.rev ?? 0, parsed.clusters ?? []);
    }

    toJson(): string {
      return JSON.stringify({ v: 1, rev: this.#rev, clusters: this.#clusters });
    }

    get rev(): number {
      return this.#rev;
    }

    get clusterCount(): number {
      return this.#clusters.length;
    }

    bumpRev(member = "some past query"): void {
      this.#rev += 1;
      this.#clusters = [...this.#clusters, { members: [member] }];
    }
  }
  return { IntentGraph: FakeIntentGraph };
});

const { attachIntentGraphSync } = await import("./intent-graph-sync.js");

interface FakeIntentGraphLike {
  readonly rev: number;
  readonly clusterCount: number;
  toJson(): string;
  bumpRev(member?: string): void;
}

class FakeCatalog {
  unsubscribed = false;
  #handler: ((batch: readonly RuntimeEvent[]) => void) | undefined;
  readonly events = {
    sourceId: "billing-agent",
    subscribe: (handler: (batch: readonly RuntimeEvent[]) => void) => {
      this.#handler = handler;
      return {
        unsubscribe: () => {
          this.unsubscribed = true;
          this.#handler = undefined;
        },
        flush: async () => {},
        droppedCount: 0,
      };
    },
  };

  emit(type: string): void {
    this.#handler?.([
      {
        v: 2,
        event_id: `evt-${Math.random().toString(36).slice(2)}`,
        ts: Date.now(),
        session_id: "session-1",
        source_id: "billing-agent",
        type,
      },
    ]);
  }
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return Response.json(body, {
    status: init.status ?? 200,
    ...(init.headers === undefined ? {} : { headers: init.headers }),
  });
}

const NO_JITTER = () => 1;

describe("attachIntentGraphSync", () => {
  const originalEnv = process.env.RATEL_CLOUD_INTENT_GRAPH;

  beforeEach(() => {
    delete process.env.RATEL_CLOUD_INTENT_GRAPH;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.RATEL_CLOUD_INTENT_GRAPH;
    else process.env.RATEL_CLOUD_INTENT_GRAPH = originalEnv;
    vi.useRealTimers();
  });

  describe("load", () => {
    it("GET 200 loads the graph and captures ETag/rev", async () => {
      const catalog = new FakeCatalog();
      const requests: string[] = [];
      const fetchImpl = (async (url: RequestInfo | URL) => {
        requests.push(String(url));
        return jsonResponse(
          {
            sourceId: "billing-agent",
            rev: 3,
            graph: { v: 1, rev: 3, clusters: [{ members: [] }] },
          },
          { headers: { ETag: '"e1"' } },
        );
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, { apiKey: "rtl_test", fetch: fetchImpl });

      expect((sync.graph as unknown as FakeIntentGraphLike).rev).toBe(3);
      expect(sync.status).toBe("idle");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("source=billing-agent");
      await sync.close();
    });

    it("GET 404 not_found starts an empty graph", async () => {
      const catalog = new FakeCatalog();
      const fetchImpl = (async () =>
        jsonResponse({ error: "not_found" }, { status: 404 })) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, { apiKey: "rtl_test", fetch: fetchImpl });

      expect((sync.graph as unknown as FakeIntentGraphLike).clusterCount).toBe(0);
      expect(sync.status).toBe("idle");
      await sync.close();
    });

    it("GET 404 feature_disabled goes terminal and warns once, with zero PUTs ever", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const catalog = new FakeCatalog();
      let requests = 0;
      const fetchImpl = (async () => {
        requests += 1;
        return jsonResponse({ error: "feature_disabled" }, { status: 404 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 10,
      });

      expect(sync.status).toBe("disabled");
      expect(warn).toHaveBeenCalledOnce();
      expect(requests).toBe(1);

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(10_000);

      expect(requests).toBe(1);
      await sync.close();
      warn.mockRestore();
    });

    it("GET 500 falls back to an empty graph, reports once, retries the GET (not a PUT), and later saves", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      const errors: unknown[] = [];
      let requests = 0;
      const fetchImpl = (async () => {
        requests += 1;
        if (requests === 1) return jsonResponse({}, { status: 500 });
        if (requests === 2) return jsonResponse({ error: "not_found" }, { status: 404 });
        return jsonResponse({ rev: 1 }, { headers: { ETag: '"e2"' } });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 10,
        random: NO_JITTER,
        onError: (err) => errors.push(err),
      });

      expect(sync.status).toBe("error");
      expect(errors).toHaveLength(1);
      expect((sync.graph as unknown as FakeIntentGraphLike).clusterCount).toBe(0);
      expect(requests).toBe(1);

      // The load-failure backoff retries the GET, not a PUT — a qualifying
      // event alone must not trigger a save before a baseline is loaded.
      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(9);
      expect(requests).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000); // INITIAL_BACKOFF_MS
      expect(requests).toBe(2);
      expect(sync.status).toBe("idle");

      // Now that a baseline (not_found) is established, a fresh qualifying
      // event debounce-triggers the first real PUT.
      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(10);
      expect(requests).toBe(3);
      expect(sync.status).toBe("idle");

      await sync.close();
    });

    it("a load retry that finds a stored graph discards local usage and calls onReplaced", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      const replaced: unknown[] = [];
      let requests = 0;
      const fetchImpl = (async () => {
        requests += 1;
        if (requests === 1) return jsonResponse({}, { status: 500 });
        return jsonResponse(
          {
            sourceId: "billing-agent",
            rev: 20,
            graph: { v: 1, rev: 20, clusters: [{ members: [] }, { members: [] }] },
          },
          { headers: { ETag: '"cloud-etag"' } },
        );
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 10,
        random: NO_JITTER,
        onReplaced: (graph) => replaced.push(graph),
      });

      // Local usage accumulates during the outage, racing rev past whatever
      // the (unknown to us) stored graph's rev might be.
      for (let index = 0; index < 5; index += 1) {
        (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      }
      expect((sync.graph as unknown as FakeIntentGraphLike).rev).toBe(5);

      await vi.advanceTimersByTimeAsync(1_000); // INITIAL_BACKOFF_MS -> retry GET
      expect(requests).toBe(2);
      expect(replaced).toHaveLength(1);
      expect((replaced[0] as FakeIntentGraphLike).rev).toBe(20);
      expect((sync.graph as unknown as FakeIntentGraphLike).rev).toBe(20);
      expect(sync.status).toBe("idle");

      // Critically: the locally-bumped (rev 5) graph was never PUT.
      expect(requests).toBe(2);
      await sync.close();
    });

    it("a load retry that finds feature_disabled goes terminal", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const catalog = new FakeCatalog();
      let requests = 0;
      const fetchImpl = (async () => {
        requests += 1;
        if (requests === 1) return jsonResponse({}, { status: 500 });
        return jsonResponse({ error: "feature_disabled" }, { status: 404 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 10,
        random: NO_JITTER,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(requests).toBe(2);
      expect(sync.status).toBe("disabled");
      expect(catalog.unsubscribed).toBe(true);

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toBe(2);

      await sync.close();
      warn.mockRestore();
    });

    it("PUT 404 feature_disabled goes terminal", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const catalog = new FakeCatalog();
      let requests = 0;
      const fetchImpl = (async () => {
        requests += 1;
        if (requests === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        return jsonResponse({ error: "feature_disabled" }, { status: 404 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 10,
        random: NO_JITTER,
      });
      expect(sync.status).toBe("idle");

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(10);

      expect(requests).toBe(2);
      expect(sync.status).toBe("disabled");
      expect(catalog.unsubscribed).toBe(true);
      expect(warn).toHaveBeenCalledOnce();

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toBe(2);

      await sync.close();
      warn.mockRestore();
    });
  });

  describe("save", () => {
    it("does not PUT when a batch arrives without moving rev", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let requests = 0;
      const fetchImpl = (async () => {
        requests += 1;
        return jsonResponse({ error: "not_found" }, { status: 404 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 10,
      });
      expect(requests).toBe(1);

      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(10_000);

      expect(requests).toBe(1);
      await sync.close();
    });

    it("PUTs exactly once after the debounce window, with If-Match set", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      const requests: RequestInit[] = [];
      let call = 0;
      const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        call += 1;
        if (call === 1) {
          return jsonResponse(
            { sourceId: "billing-agent", rev: 1, graph: { v: 1, rev: 1, clusters: [] } },
            { headers: { ETag: '"e1"' } },
          );
        }
        requests.push(init ?? {});
        return jsonResponse({ rev: 2 }, { headers: { ETag: '"e2"' } });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 2_000,
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");

      await vi.advanceTimersByTimeAsync(1_999);
      expect(requests).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers).toMatchObject({ "if-match": '"e1"' });
      expect(sync.status).toBe("idle");
      await sync.close();
    });

    it("coalesces a burst of qualifying batches into one PUT", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let call = 0;
      let puts = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        puts += 1;
        return jsonResponse({ rev: puts });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 1_000,
      });

      for (let index = 0; index < 5; index += 1) {
        (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
        catalog.emit("skill_invoke");
        await vi.advanceTimersByTimeAsync(500);
      }
      await vi.advanceTimersByTimeAsync(1_000);

      expect(puts).toBe(1);
      await sync.close();
    });

    it("updates ETag and saved rev on 200 so the next PUT reflects it", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      const ifMatches: Array<string | undefined> = [];
      let call = 0;
      const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        const headers = init?.headers as Record<string, string> | undefined;
        ifMatches.push(headers?.["if-match"]);
        return jsonResponse({ rev: call }, { headers: { ETag: `"e${call}"` } });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 100,
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(100);

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(100);

      expect(ifMatches).toEqual([undefined, '"e2"']);
      await sync.close();
    });

    it("continuous qualifying batches never let the debounce elapse, so max-wait saves instead", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let call = 0;
      let puts = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        puts += 1;
        return jsonResponse({ rev: puts });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 15_000,
        maxWaitMs: 60_000,
      });

      for (let second = 1; second <= 59; second += 1) {
        (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
        catalog.emit("invoke_start");
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(puts).toBe(0); // the debounce keeps getting pushed out; it never elapses

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(1_000); // t=60s: max-wait fires
      expect(puts).toBe(1);

      for (let second = 61; second <= 120; second += 1) {
        (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
        catalog.emit("invoke_start");
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(puts).toBe(2); // a fresh max-wait episode armed right after the first save

      await sync.close();
    });

    it("a batch arriving truly mid-flight still gets a max-wait guarantee, not just a debounce", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        if (call === 2) {
          // A real async gap: by the time this resolves, inFlightPromise has
          // already been set, so a batch emitted now is genuinely mid-flight
          // (onEventsBatch's `if (inFlightPromise) return;` path), not a
          // same-tick reentrant call that would arm the timers itself.
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return jsonResponse({ rev: call - 1 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 100_000, // much longer than maxWaitMs, so only max-wait can save
        maxWaitMs: 10_000,
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");

      await vi.advanceTimersByTimeAsync(10_000); // max-wait fires, PUT starts, awaits the inner 10ms timer
      expect(call).toBe(2);

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start"); // genuinely mid-flight now
      await vi.advanceTimersByTimeAsync(10); // the PUT resolves successfully

      expect(call).toBe(2);
      expect(sync.status).toBe("idle");

      // Without re-arming max-wait for the mid-flight change, only the 100s
      // debounce would be pending here; assert the save instead happens at
      // maxWaitMs.
      await vi.advanceTimersByTimeAsync(9_999);
      expect(call).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(call).toBe(3);

      await sync.close();
    });

    it("a single batch then silence saves once on the debounce, with no duplicate from max-wait", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        return jsonResponse({ rev: 1 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 15_000,
        maxWaitMs: 60_000,
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(call).toBe(2); // load + the one debounced save

      await vi.advanceTimersByTimeAsync(60_000);
      expect(call).toBe(2); // the armed max-wait timer was cancelled when the save started

      await sync.close();
    });

    it("maxWaitMs: 0 saves on the next tick instead of waiting for the debounce", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        return jsonResponse({ rev: 1 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 15_000,
        maxWaitMs: 0,
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(0);

      expect(call).toBe(2); // saved immediately, long before the 15s debounce could fire
      await sync.close();
    });

    it("max-wait never preempts a scheduled backoff retry after a 429", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        if (call === 2) {
          return jsonResponse(
            { error: "rate_limited" },
            { status: 429, headers: { "Retry-After": "55" } },
          );
        }
        return jsonResponse({ rev: 1 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 1_000,
        maxWaitMs: 60_000,
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(1_000); // debounced PUT fires -> 429, Retry-After: 55
      expect(call).toBe(2);

      // A qualifying batch while the backoff wait is pending must not arm an
      // independent max-wait timer that could fire before the 55s deadline.
      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(54_000); // t=1s+54s=55s from the 429, still short
      expect(call).toBe(2);

      await vi.advanceTimersByTimeAsync(1_000); // the Retry-After deadline itself
      expect(call).toBe(3);
      expect(sync.status).toBe("idle");

      await sync.close();
    });
  });

  describe("conflict", () => {
    it("409 triggers a GET, calls onReplaced with cloud's rev, and never retries the rejected write", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      const replaced: unknown[] = [];
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) {
          return jsonResponse(
            { sourceId: "billing-agent", rev: 1, graph: { v: 1, rev: 1, clusters: [] } },
            { headers: { ETag: '"e1"' } },
          );
        }
        if (call === 2) return jsonResponse({ error: "stale_graph", rev: 9 }, { status: 409 });
        if (call === 3) {
          return jsonResponse(
            {
              sourceId: "billing-agent",
              rev: 9,
              graph: { v: 1, rev: 9, clusters: [{ members: [] }] },
            },
            { headers: { ETag: '"cloud-etag"' } },
          );
        }
        throw new Error("unexpected extra request");
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 100,
        onReplaced: (graph) => replaced.push(graph),
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(100);

      expect(call).toBe(3);
      expect(replaced).toHaveLength(1);
      expect((replaced[0] as FakeIntentGraphLike).rev).toBe(9);
      expect((sync.graph as unknown as FakeIntentGraphLike).rev).toBe(9);
      expect(sync.status).toBe("idle");

      await vi.advanceTimersByTimeAsync(10_000);
      expect(call).toBe(3);
      await sync.close();
    });

    it("warns once when no onReplaced handler is provided, with no graph content in the message", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const catalog = new FakeCatalog();
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) {
          return jsonResponse(
            { sourceId: "billing-agent", rev: 1, graph: { v: 1, rev: 1, clusters: [] } },
            { headers: { ETag: '"e1"' } },
          );
        }
        if (call === 2) return jsonResponse({ error: "stale_graph", rev: 9 }, { status: 409 });
        return jsonResponse(
          {
            sourceId: "billing-agent",
            rev: 9,
            graph: { v: 1, rev: 9, clusters: [{ members: ["secret past query"] }] },
          },
          { headers: { ETag: '"cloud-etag"' } },
        );
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 100,
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(100);

      expect(warn).toHaveBeenCalledOnce();
      const message = warn.mock.calls[0]?.[0] as string;
      expect(message).not.toContain("secret past query");
      await sync.close();
      warn.mockRestore();
    });

    it("a 401 while re-fetching after a conflict stops retrying", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      const errors: unknown[] = [];
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) {
          return jsonResponse(
            { sourceId: "billing-agent", rev: 1, graph: { v: 1, rev: 1, clusters: [] } },
            { headers: { ETag: '"e1"' } },
          );
        }
        if (call === 2) return jsonResponse({ error: "stale_graph", rev: 9 }, { status: 409 });
        return jsonResponse({}, { status: 401 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 100,
        random: NO_JITTER,
        onError: (err) => errors.push(err),
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(100);

      expect(call).toBe(3);
      expect(sync.status).toBe("error");
      expect(errors).toEqual([expect.objectContaining({ kind: "auth" })]);

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(call).toBe(3);

      await sync.close();
    });

    it("a feature_disabled while re-fetching after a conflict goes terminal", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) {
          return jsonResponse(
            { sourceId: "billing-agent", rev: 1, graph: { v: 1, rev: 1, clusters: [] } },
            { headers: { ETag: '"e1"' } },
          );
        }
        if (call === 2) return jsonResponse({ error: "stale_graph", rev: 9 }, { status: 409 });
        return jsonResponse({ error: "feature_disabled" }, { status: 404 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 100,
        random: NO_JITTER,
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(100);

      expect(call).toBe(3);
      expect(sync.status).toBe("disabled");
      expect(catalog.unsubscribed).toBe(true);

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(call).toBe(3);

      await sync.close();
    });

    it("a 429 while re-fetching after a conflict honors Retry-After", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      const errors: unknown[] = [];
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) {
          return jsonResponse(
            { sourceId: "billing-agent", rev: 1, graph: { v: 1, rev: 1, clusters: [] } },
            { headers: { ETag: '"e1"' } },
          );
        }
        if (call === 2) return jsonResponse({ error: "stale_graph", rev: 9 }, { status: 409 });
        if (call === 3) {
          return jsonResponse(
            { error: "rate_limited" },
            { status: 429, headers: { "Retry-After": "5" } },
          );
        }
        return jsonResponse(
          { sourceId: "billing-agent", rev: 9, graph: { v: 1, rev: 9, clusters: [] } },
          { headers: { ETag: '"cloud-etag"' } },
        );
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 100,
        random: NO_JITTER,
        onError: (err) => errors.push(err),
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(100);

      expect(call).toBe(3);
      expect(errors).toEqual([expect.objectContaining({ kind: "rate_limited" })]);

      // The exponential default (~1000ms) must not fire the retry early.
      await vi.advanceTimersByTimeAsync(4_999);
      expect(call).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(call).toBe(4);
      expect(sync.status).toBe("idle");

      await sync.close();
    });
  });

  describe("resilience", () => {
    it("retries a network error with doubling backoff, capped, then succeeds", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        if (call === 2 || call === 3) throw new Error("network down");
        return jsonResponse({ rev: 1 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 100,
        random: NO_JITTER,
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(100); // debounce -> attempt 2 (fails)

      expect(call).toBe(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(call).toBe(2);
      await vi.advanceTimersByTimeAsync(1); // 1000ms backoff -> attempt 3 (fails)
      expect(call).toBe(3);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(call).toBe(3);
      await vi.advanceTimersByTimeAsync(1); // 2000ms backoff -> attempt 4 (succeeds)
      expect(call).toBe(4);
      expect(sync.status).toBe("idle");
      await sync.close();
    });

    it("floors backoff jitter at a quarter of the current backoff", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        if (call === 2) throw new Error("network down");
        return jsonResponse({ rev: 1 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 100,
        random: () => 0, // minimum jitter sample
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(100); // debounce -> attempt 2 (fails)
      expect(call).toBe(2);

      // Even at the minimum jitter sample, the retry must not fire before the
      // floor (a quarter of the 1000ms INITIAL_BACKOFF_MS = 250ms).
      await vi.advanceTimersByTimeAsync(249);
      expect(call).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(call).toBe(3);
      expect(sync.status).toBe("idle");
      await sync.close();
    });

    it("honors Retry-After on 429 instead of the exponential backoff", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        if (call === 2) {
          return jsonResponse(
            { error: "rate_limited" },
            { status: 429, headers: { "Retry-After": "5" } },
          );
        }
        return jsonResponse({ rev: 1 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 100,
        random: NO_JITTER,
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(100);
      expect(call).toBe(2);

      await vi.advanceTimersByTimeAsync(999);
      expect(call).toBe(2); // exponential 1000ms would have fired here; Retry-After (5s) has not
      await vi.advanceTimersByTimeAsync(4_001);
      expect(call).toBe(3);
      await sync.close();
    });

    it("reports 400 invalid_graph once and never retries that revision, but a later rev bump does PUT", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      const errors: unknown[] = [];
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        if (call === 2) {
          return jsonResponse({ error: "invalid_graph", details: ["bad"] }, { status: 400 });
        }
        return jsonResponse({ rev: 2 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 100,
        onError: (err) => errors.push(err),
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(100);

      expect(call).toBe(2);
      expect(errors).toHaveLength(1);
      expect(sync.status).toBe("idle");

      await vi.advanceTimersByTimeAsync(10_000);
      expect(call).toBe(2); // same revision never retried

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(100);
      expect(call).toBe(3);

      await sync.close();
    });

    it("load 401 stops retrying after reporting once", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      const errors: unknown[] = [];
      let requests = 0;
      const fetchImpl = (async () => {
        requests += 1;
        return jsonResponse({}, { status: 401 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 10,
        random: NO_JITTER,
        onError: (err) => errors.push(err),
      });

      expect(sync.status).toBe("error");
      expect(errors).toEqual([expect.objectContaining({ kind: "auth" })]);
      expect((sync.graph as unknown as FakeIntentGraphLike).clusterCount).toBe(0);
      expect(requests).toBe(1);

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toBe(1);

      await sync.close();
    });

    it("PUT 401 stops retrying after reporting once", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      const errors: unknown[] = [];
      let requests = 0;
      const fetchImpl = (async () => {
        requests += 1;
        if (requests === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        return jsonResponse({}, { status: 401 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 10,
        random: NO_JITTER,
        onError: (err) => errors.push(err),
      });
      expect(sync.status).toBe("idle");

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(10);

      expect(requests).toBe(2);
      expect(sync.status).toBe("error");
      expect(errors).toEqual([expect.objectContaining({ kind: "auth" })]);

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toBe(2);

      await sync.close();
    });

    it("reports 413 once and never retries that revision, but a later rev bump does PUT", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      const errors: unknown[] = [];
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        if (call === 2) return new Response(null, { status: 413 });
        return jsonResponse({ rev: 2 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 100,
        onError: (err) => errors.push(err),
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(100);

      expect(call).toBe(2);
      expect(errors).toEqual([expect.objectContaining({ kind: "invalid_graph" })]);
      expect(sync.status).toBe("idle");

      await vi.advanceTimersByTimeAsync(10_000);
      expect(call).toBe(2); // same revision never retried

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(100);
      expect(call).toBe(3);

      await sync.close();
    });

    it("a batch arriving mid-flight during a failing attempt does not delay the retry to debounceMs", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        if (call === 2) {
          // Simulate a qualifying batch landing while this PUT is in flight,
          // before it resolves as a failure.
          (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
          catalog.emit("invoke_start");
          return jsonResponse({}, { status: 500 });
        }
        return jsonResponse({ rev: 1 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 15_000, // much longer than the ~1000ms backoff delay below
        random: NO_JITTER,
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(15_000); // debounce fires -> call 2 fails
      expect(call).toBe(2);

      await vi.advanceTimersByTimeAsync(999);
      expect(call).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(call).toBe(3); // the backoff retry, not a 15s-delayed one

      await sync.close();
    });

    it("a batch arriving mid-flight during a 429 does not override Retry-After", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        if (call === 2) {
          (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
          catalog.emit("invoke_start");
          return jsonResponse(
            { error: "rate_limited" },
            { status: 429, headers: { "Retry-After": "20" } },
          );
        }
        return jsonResponse({ rev: 1 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 5_000, // shorter than Retry-After, so a stomp would fire early
        random: NO_JITTER,
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(5_000); // debounce fires -> call 2 -> 429
      expect(call).toBe(2);

      await vi.advanceTimersByTimeAsync(19_999); // just short of Retry-After: 20s
      expect(call).toBe(2);
      await vi.advanceTimersByTimeAsync(1); // the Retry-After deadline itself
      expect(call).toBe(3);

      await sync.close();
    });
  });

  describe("consume mode", () => {
    it("loads the graph, records the etag, and never PUTs even with maxWaitMs: 0", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      const methods: string[] = [];
      const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        return jsonResponse(
          { sourceId: "billing-agent", rev: 3, graph: { v: 1, rev: 3, clusters: [] } },
          { headers: { ETag: '"e1"' } },
        );
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        mode: "consume",
        maxWaitMs: 0,
      });

      expect((sync.graph as unknown as FakeIntentGraphLike).rev).toBe(3);
      expect(sync.status).toBe("idle");
      expect(methods).toEqual(["GET"]);

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start"); // no subscription exists in consume mode: a no-op
      await vi.advanceTimersByTimeAsync(60_000);

      expect(methods.every((method) => method === "GET")).toBe(true);
      await sync.close();
      expect(catalog.unsubscribed).toBe(false); // never subscribed in the first place
    });

    it("404 not_found on load exposes an empty graph and stays idle; the next poll adopts it", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      const replaced: unknown[] = [];
      const errors: unknown[] = [];
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        return jsonResponse(
          { sourceId: "cloud", rev: 4, graph: { v: 1, rev: 4, clusters: [{ members: [] }] } },
          { headers: { ETag: '"e4"' } },
        );
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        mode: "consume",
        pollIntervalMs: 15_000,
        onReplaced: (graph) => replaced.push(graph),
        onError: (err) => errors.push(err),
      });

      expect((sync.graph as unknown as FakeIntentGraphLike).clusterCount).toBe(0);
      expect(sync.status).toBe("idle");
      expect(errors).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(15_000);

      expect(call).toBe(2);
      expect(replaced).toHaveLength(1);
      expect((replaced[0] as FakeIntentGraphLike).rev).toBe(4);
      expect((sync.graph as unknown as FakeIntentGraphLike).rev).toBe(4);
      expect(errors).toHaveLength(0);

      await sync.close();
    });

    it("polls with If-None-Match using the last etag; 304 keeps the same graph and skips onReplaced", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      const replaced: unknown[] = [];
      const headersSeen: Array<string | undefined> = [];
      let call = 0;
      const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        call += 1;
        const headers = init?.headers as Record<string, string> | undefined;
        headersSeen.push(headers?.["if-none-match"]);
        if (call === 1) {
          return jsonResponse(
            { sourceId: "billing-agent", rev: 1, graph: { v: 1, rev: 1, clusters: [] } },
            { headers: { ETag: '"e1"' } },
          );
        }
        return new Response(null, { status: 304 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        mode: "consume",
        pollIntervalMs: 15_000,
        onReplaced: (graph) => replaced.push(graph),
      });

      const initialGraph = sync.graph;
      await vi.advanceTimersByTimeAsync(15_000);

      expect(call).toBe(2);
      expect(headersSeen).toEqual([undefined, '"e1"']);
      expect(sync.graph).toBe(initialGraph);
      expect(replaced).toHaveLength(0);
      expect(sync.status).toBe("idle");

      await sync.close();
    });

    it("poll 200 with a higher rev adopts, fires onReplaced, and the new etag is used next", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      const replaced: unknown[] = [];
      const headersSeen: Array<string | undefined> = [];
      let call = 0;
      const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        call += 1;
        const headers = init?.headers as Record<string, string> | undefined;
        headersSeen.push(headers?.["if-none-match"]);
        if (call === 1) {
          return jsonResponse(
            { sourceId: "billing-agent", rev: 1, graph: { v: 1, rev: 1, clusters: [] } },
            { headers: { ETag: '"e1"' } },
          );
        }
        if (call === 2) {
          return jsonResponse(
            {
              sourceId: "billing-agent",
              rev: 2,
              graph: { v: 1, rev: 2, clusters: [{ members: [] }] },
            },
            { headers: { ETag: '"e2"' } },
          );
        }
        return new Response(null, { status: 304 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        mode: "consume",
        pollIntervalMs: 15_000,
        onReplaced: (graph) => replaced.push(graph),
      });

      await vi.advanceTimersByTimeAsync(15_000); // poll 2 -> adopts rev 2
      expect(replaced).toHaveLength(1);
      expect((replaced[0] as FakeIntentGraphLike).rev).toBe(2);
      expect((sync.graph as unknown as FakeIntentGraphLike).rev).toBe(2);

      await vi.advanceTimersByTimeAsync(15_000); // poll 3, using the etag from the adoption
      expect(headersSeen).toEqual([undefined, '"e1"', '"e2"']);

      await sync.close();
    });

    it("uses graphKey in the query string instead of sourceId", async () => {
      const catalog = new FakeCatalog();
      const requests: string[] = [];
      const fetchImpl = (async (url: RequestInfo | URL) => {
        requests.push(String(url));
        return jsonResponse({ error: "not_found" }, { status: 404 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        mode: "consume",
        graphKey: "cloud",
      });

      expect(requests[0]).toContain("source=cloud");
      expect(requests[0]).not.toContain("source=billing-agent");
      await sync.close();
    });

    it("clamps pollIntervalMs below 15000ms to the floor", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        return new Response(null, { status: 304 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        mode: "consume",
        pollIntervalMs: 1_000, // below the 15000ms floor
      });

      await vi.advanceTimersByTimeAsync(14_999);
      expect(call).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(call).toBe(2);

      await sync.close();
    });

    it("429 on a poll waits max(Retry-After, pollIntervalMs)", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      const errors: unknown[] = [];
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        if (call === 2) {
          return jsonResponse(
            { error: "rate_limited" },
            { status: 429, headers: { "Retry-After": "30" } },
          );
        }
        return new Response(null, { status: 304 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        mode: "consume",
        pollIntervalMs: 15_000,
        onError: (err) => errors.push(err),
      });

      await vi.advanceTimersByTimeAsync(15_000); // first poll -> 429
      expect(call).toBe(2);
      expect(errors).toEqual([expect.objectContaining({ kind: "rate_limited" })]);

      await vi.advanceTimersByTimeAsync(29_999); // Retry-After (30s) outlasts pollIntervalMs (15s)
      expect(call).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(call).toBe(3);
      expect(sync.status).toBe("idle");

      await sync.close();
    });

    it("a network failure on a poll backs off (floor 15s) and recovers", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        if (call === 2) throw new Error("network down");
        return new Response(null, { status: 304 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        mode: "consume",
        pollIntervalMs: 15_000,
        random: NO_JITTER,
      });

      await vi.advanceTimersByTimeAsync(15_000); // first poll -> network failure
      expect(call).toBe(2);
      expect(sync.status).toBe("error");

      // nextBackoffDelay() with NO_JITTER and INITIAL_BACKOFF_MS=1000 would
      // fire at 1000ms; the consume-mode floor of 15000ms overrides it.
      await vi.advanceTimersByTimeAsync(14_999);
      expect(call).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(call).toBe(3);
      expect(sync.status).toBe("idle");

      await sync.close();
    });

    it("flush() respects an active backoff wait instead of forcing a GET", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        if (call === 2) throw new Error("network down");
        return new Response(null, { status: 304 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        mode: "consume",
        pollIntervalMs: 15_000,
        random: NO_JITTER,
      });

      await vi.advanceTimersByTimeAsync(15_000); // poll -> network failure, backoff armed
      expect(call).toBe(2);

      await sync.flush(); // must not bypass the backoff wait
      expect(call).toBe(2);

      await vi.advanceTimersByTimeAsync(15_000); // the backoff timer itself fires
      expect(call).toBe(3);

      await sync.close();
    });

    it("401 on a poll stops polling permanently", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      const errors: unknown[] = [];
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        return jsonResponse({}, { status: 401 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        mode: "consume",
        pollIntervalMs: 15_000,
        onError: (err) => errors.push(err),
      });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(call).toBe(2);
      expect(sync.status).toBe("error");
      expect(errors).toEqual([expect.objectContaining({ kind: "auth" })]);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(call).toBe(2);

      await sync.close();
    });

    it("feature_disabled on a poll goes terminal and stops polling", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const catalog = new FakeCatalog();
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        return jsonResponse({ error: "feature_disabled" }, { status: 404 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        mode: "consume",
        pollIntervalMs: 15_000,
      });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(call).toBe(2);
      expect(sync.status).toBe("disabled");

      await vi.advanceTimersByTimeAsync(60_000);
      expect(call).toBe(2);

      await sync.close();
      warn.mockRestore();
    });

    it("flush() issues one immediate GET, bypassing the poll timer", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        return new Response(null, { status: 304 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        mode: "consume",
        pollIntervalMs: 300_000,
      });

      expect(call).toBe(1);
      await sync.flush();
      expect(call).toBe(2);

      await sync.close();
    });

    it("close() stops the timer and issues no further requests", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        return jsonResponse({ error: "not_found" }, { status: 404 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        mode: "consume",
        pollIntervalMs: 15_000,
      });

      expect(call).toBe(1);
      await sync.close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(call).toBe(1);
    });

    it("throws at attach when graphKey or pollIntervalMs is passed in push mode", async () => {
      const fetchImpl = (async () =>
        jsonResponse({ error: "not_found" }, { status: 404 })) as typeof fetch;

      await expect(
        attachIntentGraphSync(new FakeCatalog(), {
          apiKey: "rtl_test",
          fetch: fetchImpl,
          graphKey: "cloud",
        }),
      ).rejects.toThrow(/consume-mode only/);

      await expect(
        attachIntentGraphSync(new FakeCatalog(), {
          apiKey: "rtl_test",
          fetch: fetchImpl,
          pollIntervalMs: 20_000,
        }),
      ).rejects.toThrow(/consume-mode only/);
    });

    it("never logs or reports a graph member string", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const catalog = new FakeCatalog();
      const errors: unknown[] = [];
      const secret = "what is my account balance";
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) {
          return jsonResponse(
            {
              sourceId: "billing-agent",
              rev: 1,
              graph: { v: 1, rev: 1, clusters: [{ members: [secret] }] },
            },
            { headers: { ETag: '"e1"' } },
          );
        }
        if (call === 2) return jsonResponse({}, { status: 500 });
        return jsonResponse({}, { status: 401 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        mode: "consume",
        pollIntervalMs: 15_000,
        random: NO_JITTER,
        onError: (err) => errors.push(err),
      });

      await vi.advanceTimersByTimeAsync(15_000); // poll -> 500 network error
      await vi.advanceTimersByTimeAsync(15_000); // backoff retry -> 401 terminal

      const haystack = JSON.stringify([...warn.mock.calls, ...log.mock.calls, ...errors]);
      expect(haystack).not.toContain(secret);

      await sync.close();
      warn.mockRestore();
      log.mockRestore();
    });

    it("RATEL_CLOUD_INTENT_GRAPH=off returns disabled with zero network activity", async () => {
      process.env.RATEL_CLOUD_INTENT_GRAPH = "off";
      const catalog = new FakeCatalog();
      let requests = 0;
      const fetchImpl = (async () => {
        requests += 1;
        return jsonResponse({ error: "not_found" }, { status: 404 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        mode: "consume",
        graphKey: "cloud",
      });

      expect(sync.status).toBe("disabled");
      expect(requests).toBe(0);
      await sync.flush();
      await sync.close();
      expect(requests).toBe(0);
    });
  });

  describe("privacy", () => {
    it("never logs or reports a graph member string", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const catalog = new FakeCatalog();
      const errors: unknown[] = [];
      const secret = "what is my invoice total for March";
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) {
          return jsonResponse(
            {
              sourceId: "billing-agent",
              rev: 1,
              graph: { v: 1, rev: 1, clusters: [{ members: [secret] }] },
            },
            { headers: { ETag: '"e1"' } },
          );
        }
        if (call === 2) return jsonResponse({ error: "invalid_graph" }, { status: 400 });
        if (call === 3) return jsonResponse({ error: "stale_graph", rev: 5 }, { status: 409 });
        if (call === 4) {
          return jsonResponse(
            {
              sourceId: "billing-agent",
              rev: 5,
              graph: { v: 1, rev: 5, clusters: [{ members: [secret] }] },
            },
            { headers: { ETag: '"e5"' } },
          );
        }
        return jsonResponse({}, { status: 500 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 10,
        onError: (err) => errors.push(err),
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(10); // 400 invalid_graph

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(10); // 409 -> replaced without onReplaced -> warns

      const haystack = JSON.stringify([...warn.mock.calls, ...log.mock.calls, ...errors]);
      expect(haystack).not.toContain(secret);

      await sync.close();
      warn.mockRestore();
      log.mockRestore();
    });
  });

  describe("close", () => {
    it("flushes a pending debounced save immediately before resolving", async () => {
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "not_found" }, { status: 404 });
        return jsonResponse({ rev: 1 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        debounceMs: 10_000,
      });

      (sync.graph as unknown as FakeIntentGraphLike).bumpRev();
      catalog.emit("invoke_start");
      expect(call).toBe(1);

      await sync.close();
      expect(call).toBe(2);
    });

    it("unsubscribes from the catalog's events", async () => {
      const catalog = new FakeCatalog();
      const fetchImpl = (async () =>
        jsonResponse({ error: "not_found" }, { status: 404 })) as typeof fetch;
      const sync = await attachIntentGraphSync(catalog, { apiKey: "rtl_test", fetch: fetchImpl });

      await sync.close();
      expect(catalog.unsubscribed).toBe(true);
    });

    it("is idempotent", async () => {
      const catalog = new FakeCatalog();
      let requests = 0;
      const fetchImpl = (async () => {
        requests += 1;
        return jsonResponse({ error: "not_found" }, { status: 404 });
      }) as typeof fetch;
      const sync = await attachIntentGraphSync(catalog, { apiKey: "rtl_test", fetch: fetchImpl });

      await Promise.all([sync.close(), sync.close()]);
      expect(requests).toBe(1); // only the initial load GET; nothing to save, nothing repeated
    });
  });

  describe("double attach", () => {
    it("rejects a second call for the same catalog", async () => {
      const catalog = new FakeCatalog();
      const fetchImpl = (async () =>
        jsonResponse({ error: "not_found" }, { status: 404 })) as typeof fetch;
      const sync = await attachIntentGraphSync(catalog, { apiKey: "rtl_test", fetch: fetchImpl });

      await expect(
        attachIntentGraphSync(catalog, { apiKey: "rtl_test", fetch: fetchImpl }),
      ).rejects.toThrow(/already called/);
      await sync.close();
    });
  });

  describe("kill switch", () => {
    it("RATEL_CLOUD_INTENT_GRAPH=off returns a disabled sync with zero network activity", async () => {
      process.env.RATEL_CLOUD_INTENT_GRAPH = "off";
      vi.useFakeTimers();
      const catalog = new FakeCatalog();
      let requests = 0;
      const fetchImpl = (async () => {
        requests += 1;
        return jsonResponse({ error: "not_found" }, { status: 404 });
      }) as typeof fetch;

      const sync = await attachIntentGraphSync(catalog, { apiKey: "rtl_test", fetch: fetchImpl });

      expect(sync.status).toBe("disabled");
      expect((sync.graph as unknown as FakeIntentGraphLike).clusterCount).toBe(0);
      expect(requests).toBe(0);

      catalog.emit("invoke_start");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(requests).toBe(0);

      await sync.flush();
      await sync.close();
      expect(requests).toBe(0);
    });
  });
});
