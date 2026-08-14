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

  it("warns once when runtime delivery has no API key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = (async () => Response.json({}, { status: 401 })) as typeof fetch;
    try {
      const first = attach(new FakeRuntime(), { apiKey: "", fetch: fetchImpl });
      const second = attach(new FakeRuntime(), { apiKey: "", fetch: fetchImpl });
      await Promise.all([first.close(), second.close()]);

      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "[ratel-cloud-sdk/runtime] RATEL_API_KEY is missing; runtime delivery will fail authentication.",
      );
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
