import { describe, expect, it } from "vitest";
import { RatelCloudSdk } from "./index.js";
import { MockCloud } from "./testing/mock-cloud.js";
import type { SuggestJobResult, WireSkill } from "./types.js";

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

const catalog = { global: [wireSkill({ id: "g1", name: "deploy-app" })] };

describe("IntentsClient.analyze", () => {
  it("extracts intents with coverage verdicts and does NOT draft", async () => {
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
    // Analyze no longer carries suggestionIds and drafts nothing.
    expect("suggestionIds" in result).toBe(false);
    expect((await sdk.suggestions.list({ status: "pending" })).count).toBe(0);

    const covered = result.intents.find((i) => i.text.includes("deploy"));
    expect(covered?.covered).toBe(true);
    expect(covered?.matchedSkillId).toBe("g1");

    const gap = result.intents.find((i) => i.text.includes("rotate"));
    expect(gap?.covered).toBe(false);
    expect(gap?.matchedSkillId).toBeNull();
  });

  it("re-analyzing an unchanged conversation is a cache hit", async () => {
    const mock = new MockCloud({ catalog });
    const sdk = makeSdk(mock);
    const input = { messages: [{ role: "user" as const, content: "rotate credentials" }] };

    const first = await sdk.intents.analyze(input);
    const second = await sdk.intents.analyze(input);
    expect(second.cached).toBe(true);
    expect(second.runId).toBe(first.runId);
    expect(second.intents[0]?.id).toBe(first.intents[0]?.id);
  });

  it("a catalog change busts the cache for an unchanged conversation", async () => {
    const mock = new MockCloud({ catalog });
    const sdk = makeSdk(mock);
    const input = { messages: [{ role: "user" as const, content: "rotate credentials" }] };

    const first = await sdk.intents.analyze(input);
    const skill = await sdk.skills.create({
      name: "rotate-credentials",
      description: "d",
      body: "b",
    });
    await sdk.skills.publish(skill.id, { expectedVersion: skill.version });

    const fresh = await sdk.intents.analyze(input);
    expect(fresh.cached).toBe(false);
    expect(fresh.catalogVersion).not.toBe(first.catalogVersion);
    expect(fresh.intents[0]?.covered).toBe(true);
  });

  it("noCache forces a live re-analysis and replaces the stored run", async () => {
    const mock = new MockCloud({ catalog });
    const sdk = makeSdk(mock);
    const input = { messages: [{ role: "user" as const, content: "rotate credentials" }] };

    const first = await sdk.intents.analyze(input);
    const forced = await sdk.intents.analyze({ ...input, noCache: true });
    expect(forced.cached).toBe(false);
    expect(forced.runId).not.toBe(first.runId);

    // A later plain analyze serves the replacement from cache.
    const third = await sdk.intents.analyze(input);
    expect(third.cached).toBe(true);
    expect(third.runId).toBe(forced.runId);
  });
});

describe("IntentsClient.list — the recurring-ask ledger", () => {
  it("accumulates occurrences across analyses, most-frequent first", async () => {
    const mock = new MockCloud({ catalog });
    const sdk = makeSdk(mock);
    await sdk.intents.analyze({ messages: [{ role: "user", content: "reset my password" }] });
    await sdk.intents.analyze({
      messages: [
        { role: "user", content: "reset my password" },
        { role: "user", content: "cancel my plan" },
      ],
    });

    const { intents, total } = await sdk.intents.list();
    expect(total).toBe(2);
    expect(intents[0]?.text).toBe("reset my password");
    expect(intents[0]?.occurrences).toBe(2);
    expect(intents[1]?.occurrences).toBe(1);
  });
});

describe("the async drafting flow — analyze → suggest → poll job → fetch", () => {
  it("drafts a pending new_skill suggestion for an intent, scoped to the end user", async () => {
    const mock = new MockCloud({ catalog });
    const sdk = makeSdk(mock);
    const run = await sdk.intents.analyze({
      messages: [{ role: "user", content: "rotate the database credentials" }],
      endUserId: "alice",
    });
    const gap = run.intents.find((i) => !i.covered);
    if (!gap) throw new Error("expected an uncovered intent");

    const { jobId } = await sdk.intents.suggest(gap.id);
    const job = await sdk.jobs.waitFor<SuggestJobResult>(jobId, { intervalMs: 5 });
    expect(job.kind).toBe("suggest_skill");
    expect(job.status).toBe("done");
    expect(job.result?.suggestionId).toBeTruthy();

    const suggestion = await sdk.suggestions.get(job.result?.suggestionId as string);
    expect(suggestion.type).toBe("new_skill");
    expect(suggestion.signalKind).toBe("coverage_gap");
    expect(suggestion.status).toBe("pending");
    expect(suggestion.endUserId).toBe("alice");
    expect(suggestion.sourceQueryIntentId).toBe(gap.id);
  });

  it("dedups: a second suggest for the same intent reports reason 'exists'", async () => {
    const mock = new MockCloud({ catalog });
    const sdk = makeSdk(mock);
    const run = await sdk.intents.analyze({
      messages: [{ role: "user", content: "rotate the database credentials" }],
    });
    const intentId = run.intents[0]?.id;
    if (!intentId) throw new Error("expected an intent");

    const firstJob = await sdk.intents.suggest(intentId);
    const first = await sdk.jobs.waitFor<SuggestJobResult>(firstJob.jobId);
    expect(first.result?.suggestionId).toBeTruthy();

    const secondJob = await sdk.intents.suggest(intentId);
    const second = await sdk.jobs.waitFor<SuggestJobResult>(secondJob.jobId);
    expect(second.result?.suggestionId).toBeNull();
    expect(second.result?.reason).toBe("exists");
  });

  it("suggest on an unknown intent id throws not_found", async () => {
    const mock = new MockCloud({ catalog });
    const sdk = makeSdk(mock);
    await expect(sdk.intents.suggest("qi_nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("closes the loop: suggest → approve → publish → the intent becomes covered", async () => {
    const mock = new MockCloud({ catalog });
    const sdk = makeSdk(mock);
    const messages = [{ role: "user" as const, content: "rotate credentials now" }];

    const gapRun = await sdk.intents.analyze({ messages, endUserId: "alice" });
    const firstIntent = gapRun.intents[0];
    if (!firstIntent) throw new Error("expected an intent");
    const { jobId } = await sdk.intents.suggest(firstIntent.id);
    const job = await sdk.jobs.waitFor<SuggestJobResult>(jobId);

    const approved = await sdk.suggestions.approve(job.result?.suggestionId as string);
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
