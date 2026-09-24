import { createRequire } from "node:module";
import { IntentGraph, ratel } from "@ratel-ai/sdk";
import { describe, expect, it } from "vitest";
import { attachIntentGraphSync } from "./intent-graph-sync.js";

const require = createRequire(import.meta.url);
const installedSdkVersion: string = (require("@ratel-ai/sdk/package.json") as { version: string })
  .version;

/** Numeric major.minor.patch comparison; a prerelease suffix (e.g. "0.13.0-rc.5")
 * parses its patch segment as 0 via `Number.parseInt`, which is fine here — RCs
 * of a version are treated as meeting that version's floor. */
function meetsMinVersion(version: string, min: readonly [number, number, number]): boolean {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < 3; index += 1) {
    const actual = parts[index] ?? 0;
    const required = min[index] ?? 0;
    if (actual !== required) return actual > required;
  }
  return true;
}

const supportsLearnFalse = meetsMinVersion(installedSdkVersion, [0, 13, 0]);

/**
 * Unlike intent-graph-sync.test.ts (which mocks `@ratel-ai/sdk` entirely for
 * fast, deterministic unit tests), this file uses the real native SDK — no
 * `vi.mock` — so `IntentGraph.fromJson`'s actual parser/validation and real
 * `rev`/`clusterCount` semantics are genuinely exercised, not stood in for.
 * `fetch` is still mocked: this needs no live Cloud server (unlike
 * attach.integration.test.ts, which is RATEL_E2E-gated for exactly that
 * reason), so it runs ungated in the normal suite, matching how attach.test.ts
 * already runs its own real-`ratel()` tests without any gate.
 */

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return Response.json(body, {
    status: init.status ?? 200,
    ...(init.headers === undefined ? {} : { headers: init.headers }),
  });
}

async function buildSeedGraph(): Promise<{
  runtime: ReturnType<typeof ratel>;
  seedGraph: IntentGraph;
}> {
  const runtime = ratel({ events: { sourceId: "billing-agent" } });
  await runtime.tools.register({
    id: "deploy_rollback",
    name: "deploy_rollback",
    description: "Roll back the last deploy.",
    inputSchema: { type: "object" },
    outputSchema: { type: "string" },
    execute: () => "rolled back",
  });
  const seedGraph = new IntentGraph();
  runtime.tools.catalog.experimentalEnableAdaptiveRanking(seedGraph);
  for (let i = 0; i < 3; i += 1) {
    runtime.tools.catalog.experimentalRecordBaselineTurn({
      query: "how do I roll back a deploy",
      invoked: ["deploy_rollback"],
    });
  }
  runtime.tools.catalog.experimentalDisableAdaptiveRanking();
  return { runtime, seedGraph };
}

describe("attachIntentGraphSync against the real @ratel-ai/sdk", () => {
  it("loads a real graph and its rev/clusterCount round-trip through the native fromJson", async () => {
    const { runtime, seedGraph } = await buildSeedGraph();
    expect(seedGraph.rev).toBeGreaterThan(0);

    const fetchImpl = (async () =>
      jsonResponse(
        {
          sourceId: "billing-agent",
          rev: seedGraph.rev,
          graph: JSON.parse(seedGraph.toJson()),
        },
        { headers: { ETag: '"e1"' } },
      )) as typeof fetch;

    const sync = await attachIntentGraphSync(runtime, { apiKey: "rtl_test", fetch: fetchImpl });

    expect(sync.graph).toBeInstanceOf(IntentGraph);
    expect(sync.graph.rev).toBe(seedGraph.rev);
    expect(sync.graph.clusterCount).toBe(seedGraph.clusterCount);
    await sync.close();
  });

  it("a debounced save embeds a graph the native fromJson genuinely accepts", async () => {
    const { runtime, seedGraph } = await buildSeedGraph();
    const bodies: string[] = [];
    let call = 0;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        return jsonResponse(
          { sourceId: "billing-agent", rev: seedGraph.rev, graph: JSON.parse(seedGraph.toJson()) },
          { headers: { ETag: '"e1"' } },
        );
      }
      bodies.push(String(init?.body ?? ""));
      return jsonResponse({ rev: 0 });
    }) as typeof fetch;

    const sync = await attachIntentGraphSync(runtime, {
      apiKey: "rtl_test",
      fetch: fetchImpl,
      debounceMs: 10,
    });
    const revAtLoad = sync.graph.rev;

    // Wire the real, now-adopted graph back into the catalog and record more
    // real usage on it — exactly the README's onReplaced re-wiring pattern.
    runtime.tools.catalog.experimentalEnableAdaptiveRanking(sync.graph);
    runtime.tools.catalog.experimentalRecordBaselineTurn({
      query: "roll back the production deploy right now",
      invoked: ["deploy_rollback"],
    });
    expect(sync.graph.rev).toBeGreaterThan(revAtLoad);

    await sync.flush();

    expect(bodies).toHaveLength(1);
    const body = bodies[0] ?? "";
    const graphJson = body.slice(body.indexOf('"graph":') + '"graph":'.length, -1);
    const parsedBack = IntentGraph.fromJson(graphJson);
    expect(parsedBack.rev).toBe(sync.graph.rev);

    await sync.close();
  });

  it("fromJson throws on malformed JSON and on an unknown schema version", () => {
    expect(() => IntentGraph.fromJson("not json")).toThrow();
    expect(() => IntentGraph.fromJson('{"v":999,"rev":0,"clusters":[]}')).toThrow();
  });

  (supportsLearnFalse ? it : it.skip)(
    `consume mode + learn: false keeps the adopted graph inert during search/invoke ` +
      `(requires @ratel-ai/sdk >=0.13.0, installed ${installedSdkVersion})`,
    async () => {
      const { runtime, seedGraph } = await buildSeedGraph();
      const graphJson = seedGraph.toJson();

      const fetchImpl = (async () =>
        jsonResponse(
          { sourceId: "cloud", rev: seedGraph.rev, graph: JSON.parse(graphJson) },
          { headers: { ETag: '"cloud-e1"' } },
        )) as typeof fetch;

      const sync = await attachIntentGraphSync(runtime, {
        apiKey: "rtl_test",
        fetch: fetchImpl,
        mode: "consume",
        graphKey: "cloud",
      });

      // @ts-expect-error — `learn` lands on the installed devDependency only at >=0.13.0.
      runtime.tools.catalog.experimentalEnableAdaptiveRanking(sync.graph, { learn: false });
      const revBefore = sync.graph.rev;
      const jsonBefore = sync.graph.toJson();

      runtime.tools.search("how do I roll back a deploy", 1);
      await runtime.tools.invoke("deploy_rollback", {});

      expect(sync.graph.rev).toBe(revBefore);
      expect(sync.graph.toJson()).toBe(jsonBefore);

      await sync.close();
    },
  );
});
