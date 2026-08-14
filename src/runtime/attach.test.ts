import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../types.js";
import { attach, type RatelRuntime, type RatelRuntimeEvents } from "./attach.js";

const EVENT: RuntimeEvent = {
  v: 2,
  event_id: "01J00000000000000000000000",
  ts: 1_750_000_000_000,
  session_id: "session-1",
  source_id: "service-a",
  type: "search",
};

describe("attach", () => {
  it.each([
    [302, "gated"],
    [401, "auth"],
    [404, "not_deployed"],
    [429, "rate_limited"],
  ] as const)(
    "classifies verify HTTP %i as %s without following redirects",
    async (status, kind) => {
      const requests: RequestInit[] = [];
      const handle = attach(new FakeRuntime(), {
        apiKey: "rtl_test",
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          requests.push(init ?? {});
          return new Response(null, { status });
        }) as typeof fetch,
        retry: { maxAttempts: status === 302 ? 3 : 1 },
        warnOnFailure: false,
      });

      await expect(handle.verify()).resolves.toMatchObject({ kind, status });
      expect(requests).toEqual([
        expect.objectContaining({
          method: "POST",
          body: '{"events":[]}',
          redirect: "manual",
        }),
      ]);
    },
  );

  it("transitions status from ok to blocked and back to ok", async () => {
    const eventStatuses = [202, 302, 202];
    const handle = attach(new FakeRuntime(), {
      apiKey: "rtl_test",
      fetch: (async (input: RequestInfo | URL) =>
        String(input).endsWith("/events")
          ? new Response(null, { status: eventStatuses.shift() ?? 500 })
          : Response.json({}, { status: 200 })) as typeof fetch,
      retry: { maxAttempts: 1 },
      warnOnFailure: false,
    });
    await handle.flush();

    await handle.verify();
    expect(handle.status().overall).toBe("ok");
    await handle.verify();
    expect(handle.status().overall).toBe("blocked");
    await handle.verify();
    expect(handle.status().overall).toBe("ok");
  });

  it("tracks event counters and per-source snapshot durability", async () => {
    const runtime = new FakeRuntime();
    const handle = attach(runtime, {
      apiKey: "rtl_test",
      queueCapacity: 1,
      warnOnFailure: false,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/events")) {
          const body = JSON.parse(String(init?.body)) as { events: RuntimeEvent[] };
          return Response.json(
            { accepted: body.events.length, duplicates: 0, rejected: [] },
            { status: 202 },
          );
        }
        return Response.json({}, { status: 200 });
      }) as typeof fetch,
    });

    runtime.emit({ ...EVENT, event_id: "dropped" });
    runtime.emit({ ...EVENT, event_id: "kept" });
    await handle.flush();

    expect(handle.status()).toMatchObject({
      overall: "ok",
      events: {
        lastOutcome: { kind: "ok", status: 202 },
        lastAcceptedAt: expect.any(Number),
        lastAttemptAt: expect.any(Number),
        lastError: null,
        accepted: 2,
        rejected: 0,
        dropped: 1,
      },
      snapshots: {
        "service-a": {
          lastDurableAt: expect.any(Number),
          pendingSince: null,
          lastOutcome: { kind: "ok", status: 200 },
        },
      },
    });
    expect(() => JSON.stringify(handle.status())).not.toThrow();
  });

  it("classifies partial event acceptance as a payload rejection", async () => {
    const runtime = new FakeRuntime();
    const handle = attach(runtime, {
      apiKey: "rtl_test",
      warnOnFailure: false,
      fetch: (async (input: RequestInfo | URL) =>
        String(input).endsWith("/events")
          ? Response.json(
              {
                accepted: 0,
                duplicates: 0,
                rejected: [{ event_id: EVENT.event_id, reason: "invalid event" }],
              },
              { status: 202 },
            )
          : Response.json({}, { status: 200 })) as typeof fetch,
    });
    runtime.emit(EVENT);

    await handle.flush();

    expect(handle.status()).toMatchObject({
      overall: "degraded",
      events: {
        lastOutcome: { kind: "rejected_payload", status: 202 },
        accepted: 0,
        rejected: 1,
      },
    });
  });

  it("invokes status callbacks only when an outcome kind changes", async () => {
    const kinds: Array<string | null> = [];
    const statuses = [401, 401, 202];
    const handle = attach(new FakeRuntime(), {
      apiKey: "rtl_test",
      warnOnFailure: false,
      onStatusChange: (status) => kinds.push(status.events.lastOutcome?.kind ?? null),
      fetch: (async (input: RequestInfo | URL) =>
        String(input).endsWith("/events")
          ? new Response(null, { status: statuses.shift() ?? 202 })
          : Response.json({}, { status: 200 })) as typeof fetch,
      retry: { maxAttempts: 1 },
    });
    await handle.flush();

    await handle.verify();
    await handle.verify();
    await handle.verify();

    expect(kinds).toEqual([null, "auth", "ok"]);
  });

  it("warns once per failing kind until delivery recovers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const statuses = [401, 401, 404, 404, 202, 401];
    try {
      const handle = attach(new FakeRuntime(), {
        apiKey: "rtl_test",
        fetch: (async (input: RequestInfo | URL) =>
          String(input).endsWith("/events")
            ? new Response(null, { status: statuses.shift() ?? 202 })
            : Response.json({}, { status: 200 })) as typeof fetch,
        retry: { maxAttempts: 1 },
      });
      await handle.flush();

      for (let index = 0; index < 6; index += 1) await handle.verify();

      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        "[ratel-cloud-sdk/runtime] auth: authentication failed — facts are not persisting",
        "[ratel-cloud-sdk/runtime] not_deployed: the runtime ingestion endpoint is not deployed — facts are not persisting",
        "[ratel-cloud-sdk/runtime] auth: authentication failed — facts are not persisting",
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("reports disabled when RATEL_CLOUD_EVENTS is off", () => {
    const previous = process.env.RATEL_CLOUD_EVENTS;
    process.env.RATEL_CLOUD_EVENTS = "off";
    try {
      const handle = attach(new FakeRuntime(), { apiKey: "rtl_test", warnOnFailure: false });

      expect(handle.status().overall).toBe("disabled");
    } finally {
      if (previous === undefined) delete process.env.RATEL_CLOUD_EVENTS;
      else process.env.RATEL_CLOUD_EVENTS = previous;
    }
  });

  it("streams subscribed SDK runtime events to Cloud", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const runtime = new FakeRuntime();
    const handle = attach(runtime, {
      apiKey: "rtl_test",
      baseUrl: "https://cloud.test/api/v1/",
      sourceId: "deployment-a",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), init });
        return Response.json({ accepted: 1, duplicates: 0, rejected: [] }, { status: 202 });
      }) as typeof fetch,
    });

    runtime.emit(EVENT);
    await handle.flush();

    expect(requests.find((request) => request.url.endsWith("/events"))?.init?.body).toBe(
      JSON.stringify({ events: [{ ...EVENT, source_id: "deployment-a" }] }),
    );
  });

  it("forwards only remotely publishable event types to Cloud", async () => {
    const delivered: RuntimeEvent[] = [];
    const runtime = new FakeRuntime();
    const handle = attach(runtime, {
      apiKey: "rtl_test",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/events")) {
          delivered.push(...(JSON.parse(String(init?.body)) as { events: RuntimeEvent[] }).events);
        }
        return Response.json({}, { status: 202 });
      }) as typeof fetch,
    });

    runtime.emit({ ...EVENT, event_id: "allowed", type: "invoke_start" });
    runtime.emit({ ...EVENT, event_id: "local-paths", type: "embedder_load" });
    runtime.emit({ ...EVENT, event_id: "local-search", type: "fact_search" });
    await handle.flush();
    await handle.close();

    expect(delivered.map((event) => event.event_id)).toEqual(["allowed"]);
  });

  it("publishes the latest complete catalog on attach and registration churn", async () => {
    const snapshots: unknown[] = [];
    const runtime = new FakeRuntime();
    runtime.setTools([tool("weather")]);
    const handle = attach(runtime, {
      apiKey: "rtl_test",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/catalog/snapshot")) {
          snapshots.push(JSON.parse(String(init?.body)));
        }
        return Response.json({}, { headers: { ETag: `"version-${snapshots.length}"` } });
      }) as typeof fetch,
    });

    await handle.flush();
    runtime.setTools([tool("weather"), tool("calendar")]);
    runtime.emit({ ...EVENT, event_id: "churn-1", type: "index_churn" });
    await handle.flush();

    expect(snapshots).toEqual([
      { source_id: "service-a", tools: [wireTool("weather")] },
      {
        source_id: "service-a",
        tools: [wireTool("weather"), wireTool("calendar")],
      },
    ]);
  });

  it("builds one catalog snapshot after a burst of tool churn", async () => {
    vi.useFakeTimers();
    const runtime = new FakeRuntime();
    const snapshot = vi.spyOn(runtime.catalog, "snapshot");
    try {
      const handle = attach(runtime, {
        apiKey: "rtl_test",
        snapshotDebounceMs: 100,
        fetch: (async () =>
          Response.json({}, { headers: { ETag: '"published"' } })) as typeof fetch,
      });

      for (let index = 0; index < 100; index += 1) {
        runtime.setTools([tool(`tool-${index}`)]);
        runtime.emit({ ...EVENT, event_id: `churn-${index}`, type: "index_churn" });
      }
      await vi.advanceTimersByTimeAsync(99);
      expect(snapshot).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(snapshot).toHaveBeenCalledOnce();
      await handle.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a quiet churn period before building the catalog snapshot", async () => {
    vi.useFakeTimers();
    const runtime = new FakeRuntime();
    const snapshot = vi.spyOn(runtime.catalog, "snapshot");
    try {
      const handle = attach(runtime, {
        apiKey: "rtl_test",
        snapshotDebounceMs: 100,
        fetch: (async () =>
          Response.json({}, { headers: { ETag: '"published"' } })) as typeof fetch,
      });

      await vi.advanceTimersByTimeAsync(50);
      runtime.emit({ ...EVENT, event_id: "churn", type: "index_churn" });
      await vi.advanceTimersByTimeAsync(50);
      expect(snapshot).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(50);

      expect(snapshot).toHaveBeenCalledOnce();
      await handle.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not rebuild the tool snapshot for skill churn", async () => {
    const runtime = new FakeRuntime();
    const snapshot = vi.spyOn(runtime.catalog, "snapshot");
    const handle = attach(runtime, {
      apiKey: "rtl_test",
      fetch: (async () => Response.json({}, { headers: { ETag: '"published"' } })) as typeof fetch,
    });

    await handle.flush();
    runtime.emit({ ...EVENT, event_id: "skill-churn", type: "skill_churn" });
    await handle.flush();

    expect(snapshot).toHaveBeenCalledOnce();
    await handle.close();
  });

  it("reconciles on the configured interval until the attachment closes", async () => {
    vi.useFakeTimers();
    let snapshots = 0;
    try {
      const handle = attach(new FakeRuntime(), {
        apiKey: "rtl_test",
        snapshotDebounceMs: 0,
        snapshotReconcileIntervalMs: 100,
        fetch: (async (input: RequestInfo | URL) => {
          if (String(input).endsWith("/catalog/snapshot")) snapshots += 1;
          return Response.json({}, { headers: { ETag: `"version-${snapshots}"` } });
        }) as typeof fetch,
      });

      await handle.flush();
      await vi.advanceTimersByTimeAsync(100);
      expect(snapshots).toBe(2);
      await handle.close();
      await vi.advanceTimersByTimeAsync(100);

      expect(snapshots).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces terminal snapshot failures through the attachment rejection hook", async () => {
    const rejected: Array<{ eventId: string | null; reason: string }> = [];
    const handle = attach(new FakeRuntime(), {
      apiKey: "rtl_test",
      fetch: (async (input: RequestInfo | URL) =>
        String(input).endsWith("/catalog/snapshot")
          ? Response.json({ error: "malformed" }, { status: 400 })
          : Response.json({}, { status: 202 })) as typeof fetch,
      onRejected: (items) => rejected.push(...items),
    });

    await handle.flush();

    expect(rejected).toContainEqual({
      eventId: null,
      reason: "catalog snapshot for service-a rejected with HTTP 400",
    });
  });

  it("reuses one attachment and detaches it cleanly on close", async () => {
    const delivered: RuntimeEvent[] = [];
    const runtime = new FakeRuntime();
    const options = {
      apiKey: "rtl_test",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/events")) {
          delivered.push(...(JSON.parse(String(init?.body)) as { events: RuntimeEvent[] }).events);
        }
        return Response.json({}, { status: 202 });
      }) as typeof fetch,
    };

    const first = attach(runtime, options);
    const second = attach(runtime, options);
    runtime.emit({ ...EVENT, event_id: "before-close" });
    await first.close();
    runtime.emit({ ...EVENT, event_id: "after-close" });
    await second.flush();

    expect({
      sameHandle: first === second,
      subscriptions: runtime.subscriptionCount,
      delivered,
    }).toEqual({
      sameHandle: true,
      subscriptions: 1,
      delivered: [{ ...EVENT, event_id: "before-close" }],
    });
  });

  it("drains native queued events before unsubscribing on close", async () => {
    const delivered: RuntimeEvent[] = [];
    let handler: ((batch: readonly RuntimeEvent[]) => void | PromiseLike<void>) | undefined;
    let queued: RuntimeEvent[] = [{ ...EVENT, event_id: "native-queued" }];
    const runtime = {
      events: {
        sourceId: "service-a",
        subscribe: (next: typeof handler) => {
          handler = next;
          return {
            droppedCount: 0,
            flush: async () => {
              const batch = queued;
              queued = [];
              await handler?.(batch);
            },
            unsubscribe: () => {
              handler = undefined;
              queued = [];
            },
          };
        },
      },
      catalog: { snapshot: () => ({ source_id: "service-a", tools: [], skills: [] }) },
    } satisfies RatelRuntime;
    const handle = attach(runtime, {
      apiKey: "rtl_test",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/events")) {
          delivered.push(...(JSON.parse(String(init?.body)) as { events: RuntimeEvent[] }).events);
        }
        return Response.json({}, { headers: { ETag: '"published"' } });
      }) as typeof fetch,
    });

    await handle.close();

    expect(delivered).toEqual([{ ...EVENT, event_id: "native-queued" }]);
  });

  it("sends nothing to Cloud after close() resolves", async () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    let emitDuringPost: (() => void) | undefined;
    let handler: ((batch: readonly RuntimeEvent[]) => void | PromiseLike<void>) | undefined;
    const runtime = {
      events: {
        sourceId: "service-a",
        subscribe: (next: typeof handler) => {
          handler = next;
          return {
            droppedCount: 0,
            flush: async () => {},
            unsubscribe: () => {
              // The native drain contract keeps delivering envelopes already queued.
            },
          };
        },
      },
      catalog: { snapshot: () => ({ source_id: "service-a", tools: [], skills: [] }) },
    } satisfies RatelRuntime;
    try {
      const handle = attach(runtime, {
        apiKey: "rtl_test",
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).endsWith("/events")) {
            posts.push(String(init?.body));
            emitDuringPost?.();
            emitDuringPost = undefined;
          }
          return Response.json({}, { status: 202 });
        }) as typeof fetch,
      });
      emitDuringPost = () => handler?.([{ ...EVENT, event_id: "during-close" }]);
      handler?.([{ ...EVENT, event_id: "before-close" }]);

      await handle.close();
      const postsWhenClosed = posts.length;
      handler?.([{ ...EVENT, event_id: "after-close" }]);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(posts.length).toBe(postsWhenClosed);
      expect(handle.status().events.dropped).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails open when the SDK event subscription cannot be created", async () => {
    const runtime = {
      events: {
        sourceId: "service-a",
        subscribe: () => {
          throw new Error("native bridge unavailable");
        },
      },
      catalog: { snapshot: () => ({ source_id: "service-a", tools: [], skills: [] }) },
    } as RatelRuntime;
    let handle: ReturnType<typeof attach> | undefined;

    expect(() => {
      handle = attach(runtime, { apiKey: "rtl_test" });
    }).not.toThrow();
    await expect(handle?.flush()).resolves.toBeUndefined();
    await expect(handle?.close()).resolves.toBeUndefined();
  });

  it("fails open when the SDK subscription lifecycle rejects", async () => {
    const runtime = {
      events: {
        sourceId: "service-a",
        subscribe: () => ({
          droppedCount: 0,
          unsubscribe: () => {},
          flush: async () => {
            throw new Error("native drain failed");
          },
        }),
      },
      catalog: { snapshot: () => ({ source_id: "service-a", tools: [], skills: [] }) },
    } as RatelRuntime;
    const handle = attach(runtime, {
      apiKey: "rtl_test",
      fetch: (async () => Response.json({}, { status: 202 })) as typeof fetch,
    });

    await expect(handle.flush()).resolves.toBeUndefined();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it("suppresses runtime delivery warnings when requested", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = (async () => Response.json({}, { status: 401 })) as typeof fetch;
    try {
      const first = attach(new FakeRuntime(), {
        apiKey: "",
        fetch: fetchImpl,
        warnOnFailure: false,
      });
      const second = attach(new FakeRuntime(), {
        apiKey: "",
        fetch: fetchImpl,
        warnOnFailure: false,
      });
      await Promise.all([first.close(), second.close()]);

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("accepts the SDK's named JSON Schema type structurally", () => {
    interface SdkJsonSchema {
      readonly type?: "object" | "string";
    }
    const sdkRuntime = {} as {
      readonly events: RatelRuntimeEvents;
      readonly catalog: {
        snapshot(): {
          readonly source_id: string;
          readonly tools: readonly {
            readonly id: string;
            readonly name: string;
            readonly description: string;
            readonly inputSchema: SdkJsonSchema;
            readonly outputSchema: SdkJsonSchema;
          }[];
          readonly skills: readonly unknown[];
        };
      };
    };
    const compatible: RatelRuntime = sdkRuntime;

    expect(compatible).toBe(sdkRuntime);
  });
});

class FakeRuntime {
  subscriptionCount = 0;
  #tools: Array<ReturnType<typeof tool>> = [];
  readonly catalog = {
    snapshot: () => ({ source_id: "service-a", tools: this.#tools, skills: [] }),
  };
  readonly events = {
    sourceId: "service-a",
    subscribe: (handler: (batch: readonly RuntimeEvent[]) => void) => {
      this.subscriptionCount += 1;
      this.#handler = handler;
      return {
        unsubscribe: () => {
          this.#handler = undefined;
        },
        flush: async () => {},
        droppedCount: 0,
      };
    },
  };
  #handler: ((batch: readonly RuntimeEvent[]) => void) | undefined;

  emit(event: RuntimeEvent): void {
    this.#handler?.([event]);
  }

  setTools(tools: Array<ReturnType<typeof tool>>): void {
    this.#tools = tools;
  }
}

function tool(id: string) {
  return {
    id,
    name: id,
    description: `${id} description`,
    inputSchema: { type: "object" },
    outputSchema: { type: "string" },
  };
}

function wireTool(id: string) {
  return {
    id,
    name: id,
    description: `${id} description`,
    input_schema: { type: "object" },
    output_schema: { type: "string" },
    metadata: null,
  };
}
