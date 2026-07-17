import { describe, expect, it } from "vitest";
import { RatelCloudSdk } from "./index.js";
import { MockCloud } from "./testing/mock-cloud.js";
import type { WireSkill } from "./types.js";

function wireSkill(overrides: Partial<WireSkill> & { id: string; name: string }): WireSkill {
  return { description: "d", tags: [], tools: [], metadata: {}, body: "b", ...overrides };
}

function makeSdk(mock: MockCloud): RatelCloudSdk {
  return new RatelCloudSdk({
    apiKey: mock.apiKey,
    baseUrl: "https://mock.test/api/v1",
    fetch: mock.fetch,
  });
}

describe("IntentsClient.analyze", () => {
  const catalog = { global: [wireSkill({ id: "g1", name: "deploy-app" })] };

  it("extracts intents with coverage verdicts against the published catalog", async () => {
    const mock = new MockCloud({ catalog });
    const sdk = makeSdk(mock);
    const result = await sdk.intents.analyze({
      messages: [
        { role: "user", content: "how do I deploy the app to prod?" },
        { role: "assistant", content: "…" },
        { role: "user", content: "rotate the database credentials" },
      ],
    });

    expect(result.runId).toMatch(/^run_/);
    expect(result.cached).toBe(false);
    expect(result.catalogVersion).not.toBeNull();
    expect(result.intents).toHaveLength(2);

    const covered = result.intents.find((i) => i.text.includes("deploy"));
    expect(covered?.covered).toBe(true);
    expect(covered?.matchedSkillId).toBe("g1");

    const gap = result.intents.find((i) => i.text.includes("rotate"));
    expect(gap?.covered).toBe(false);
    expect(result.suggestionIds).toHaveLength(1);
  });

  it("drafts a pending new_skill suggestion per coverage gap, scoped to the end user", async () => {
    const mock = new MockCloud({ catalog });
    const sdk = makeSdk(mock);
    const result = await sdk.intents.analyze({
      messages: [{ role: "user", content: "rotate the database credentials" }],
      endUserId: "alice",
    });

    const listed = await sdk.suggestions.list({ status: "pending", endUserId: "alice" });
    expect(listed.suggestions.map((s) => s.id)).toEqual(result.suggestionIds);
    expect(listed.suggestions[0]?.signalKind).toBe("coverage_gap");
  });

  it("re-analyzing an unchanged conversation is a cache hit", async () => {
    const mock = new MockCloud({ catalog });
    const sdk = makeSdk(mock);
    const input = { messages: [{ role: "user" as const, content: "rotate credentials" }] };

    const first = await sdk.intents.analyze(input);
    const second = await sdk.intents.analyze(input);
    expect(second.cached).toBe(true);
    expect(second.runId).toBe(first.runId);
    // No duplicate gap suggestion from the cached run.
    const pending = await sdk.suggestions.list({ status: "pending" });
    expect(pending.count).toBe(1);
  });

  it("closes the loop: approve the gap draft, publish, and the intent becomes covered", async () => {
    const mock = new MockCloud({ catalog });
    const sdk = makeSdk(mock);
    const messages = [{ role: "user" as const, content: "rotate credentials now" }];

    const gapRun = await sdk.intents.analyze({ messages, endUserId: "alice" });
    expect(gapRun.suggestionIds).toHaveLength(1);

    const approved = await sdk.suggestions.approve(gapRun.suggestionIds[0] as string);
    const draft = await sdk.skills.get(approved.createdSkillId as string);
    await sdk.skills.publish(draft.id, { expectedVersion: draft.version });

    // The published draft ("rotate-credentials-now") now covers the same ask.
    const rerun = await sdk.intents.analyze({
      messages: [...messages, { role: "user" as const, content: "rotate credentials now please" }],
      endUserId: "alice",
    });
    const intent = rerun.intents.find((i) => i.text === "rotate credentials now please");
    expect(intent?.covered).toBe(true);
    expect(intent?.matchedSkillId).toBe(draft.id);
  });
});
