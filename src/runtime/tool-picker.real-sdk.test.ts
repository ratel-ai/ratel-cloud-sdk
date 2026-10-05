import { RetrieverError, ratel } from "@ratel-ai/sdk";
import { describe, expect, it } from "vitest";
import { attach } from "./attach.js";
import { ratelCloud } from "./tool-picker.js";

/**
 * The Tool Picker as a real `ratel()` runtime's ranking function, with
 * `attach()` publishing the catalog snapshot the picker ranks. `fetch` stands
 * in for Cloud, so this runs ungated like intent-graph-sync.real-sdk.test.ts.
 */

const BASE_URL = "https://mock.test/api/v1";

const TOOLS = [
  { id: "deploy", description: "Deploy the service to production." },
  { id: "rollback", description: "Roll back the last production deploy." },
  { id: "page_oncall", description: "Page the on-call engineer." },
];

/** Cloud's ranking, deliberately unlike BM25's for "roll back prod". */
const PICK_ORDER = ["page_oncall", "rollback", "deploy"];

/** Picks the synced tools in PICK_ORDER, plus one id this runtime never registered. */
function fakeCloud(pick: () => Response | undefined = () => undefined) {
  const log: string[] = [];
  let synced: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/catalog/snapshot")) {
      log.push("snapshot");
      const body = JSON.parse(String(init?.body)) as { tools: Array<{ id: string }> };
      synced = body.tools.map((tool) => tool.id);
      return Response.json({ synced: true });
    }
    if (url.endsWith("/tools/pick")) {
      log.push("pick");
      const override = pick();
      if (override !== undefined) return override;
      if (synced.length === 0) {
        return Response.json({ error: { message: "Sync your catalog" } }, { status: 409 });
      }
      const tools = PICK_ORDER.filter((id) => synced.includes(id)).map((id, i) => ({
        id,
        score: 0.9 - i * 0.2,
      }));
      return Response.json({
        mode: "precise",
        tools: [...tools, { id: "ghost_tool", score: 0.05 }],
      });
    }
    return Response.json({}, { status: 202 });
  }) as typeof fetch;
  return { log, fetch: fetchImpl };
}

async function registerTools(runtime: ReturnType<typeof ratel>): Promise<void> {
  for (const tool of TOOLS) {
    await runtime.tools.register({
      ...tool,
      name: tool.id,
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
      execute: () => tool.id,
    });
  }
}

describe("ratelCloud().toolPicker against the real @ratel-ai/sdk", () => {
  it("ranks a custom search from the snapshot attach() published", async () => {
    const cloud = fakeCloud();
    const rc = ratelCloud({ apiKey: "rk", baseUrl: BASE_URL, fetch: cloud.fetch });
    const runtime = ratel({
      events: { sourceId: "ops-agent" },
      method: "custom",
      retrieveFn: rc.toolPicker,
    });
    const handle = attach(runtime, {
      apiKey: "rk",
      baseUrl: BASE_URL,
      fetch: cloud.fetch,
      warnOnFailure: false,
    });
    await registerTools(runtime);
    await handle.flush();

    const hits = await runtime.tools.searchAsync("roll back prod", 5);

    expect(hits.map((hit) => hit.toolId)).toEqual(PICK_ORDER);
    expect(cloud.log.indexOf("snapshot")).toBeLessThan(cloud.log.indexOf("pick"));
    await handle.close();
  });

  it("falls back to BM25 order when the picker fails transiently as a reranker", async () => {
    const baseline = ratel({ events: { sourceId: "ops-agent" } });
    await registerTools(baseline);
    const bm25 = (await baseline.tools.searchAsync("roll back production deploy", 3)).map(
      (hit) => hit.toolId,
    );

    const cloud = fakeCloud(() => Response.json({ error: { message: "busy" } }, { status: 503 }));
    const rc = ratelCloud({ apiKey: "rk", baseUrl: BASE_URL, fetch: cloud.fetch });
    const runtime = ratel({ events: { sourceId: "ops-agent" }, rerankerFn: rc.toolPicker });
    await registerTools(runtime);

    const hits = await runtime.tools.searchAsync("roll back production deploy", 3);

    expect(cloud.log).toContain("pick");
    expect(hits.map((hit) => hit.toolId)).toEqual(bm25);
  });

  it("fails the search when the picker fails permanently as a reranker", async () => {
    const cloud = fakeCloud(() =>
      Response.json({ error: { message: "bad key" } }, { status: 401 }),
    );
    const rc = ratelCloud({ apiKey: "rk", baseUrl: BASE_URL, fetch: cloud.fetch });
    const runtime = ratel({ events: { sourceId: "ops-agent" }, rerankerFn: rc.toolPicker });
    await registerTools(runtime);

    await expect(runtime.tools.searchAsync("roll back", 3)).rejects.toSatisfy(
      (error) => error instanceof RetrieverError && error.code === "Unauthorized",
    );
  });
});
