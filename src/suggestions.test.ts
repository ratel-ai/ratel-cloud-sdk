import { describe, expect, it } from "vitest";
import { RatelCloudSdk } from "./index.js";
import { MockCloud } from "./testing/mock-cloud.js";

function makeSdk(mock = new MockCloud()): { sdk: RatelCloudSdk; mock: MockCloud } {
  const sdk = new RatelCloudSdk({
    apiKey: mock.apiKey,
    baseUrl: "https://mock.test/api/v1",
    fetch: mock.fetch,
  });
  return { sdk, mock };
}

describe("SuggestionsClient", () => {
  it("lists with status/type filters and rejects invalid filter values", async () => {
    const mock = new MockCloud();
    mock.seedSuggestion({ type: "new_skill", status: "pending" });
    mock.seedSuggestion({ type: "edit_skill", status: "rejected" });
    const { sdk } = makeSdk(mock);

    const pending = await sdk.suggestions.list({ status: "pending" });
    expect(pending.count).toBe(1);
    expect(pending.suggestions[0]?.type).toBe("new_skill");

    const edits = await sdk.suggestions.list({ type: "edit_skill" });
    expect(edits.count).toBe(1);

    await expect(sdk.suggestions.list({ status: "bogus" as never })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("filters by endUserId", async () => {
    const mock = new MockCloud();
    mock.seedSuggestion({ endUserId: "alice" });
    mock.seedSuggestion({ endUserId: null });
    const { sdk } = makeSdk(mock);
    const alices = await sdk.suggestions.list({ endUserId: "alice" });
    expect(alices.count).toBe(1);
    expect(alices.suggestions[0]?.endUserId).toBe("alice");
  });

  it("generate returns a job id", async () => {
    const { sdk } = makeSdk();
    const result = await sdk.suggestions.generate();
    expect(result.jobId).toMatch(/^job_/);
    expect(result.coalesced).toBe(false);
  });

  it("approving a new_skill drafts the skill and stamps createdSkillId", async () => {
    const mock = new MockCloud();
    const seeded = mock.seedSuggestion({
      type: "new_skill",
      endUserId: "alice",
      patch: { name: "alice-helper", description: "d", tags: [], body: "b", model: "m" },
    });
    const { sdk } = makeSdk(mock);

    const approved = await sdk.suggestions.approve(seeded.id);
    expect(approved.status).toBe("approved");
    expect(approved.createdSkillId).not.toBeNull();

    const skill = await sdk.skills.get(approved.createdSkillId as string);
    expect(skill.name).toBe("alice-helper");
    expect(skill.status).toBe("draft");
    expect(skill.endUserId).toBe("alice");
  });

  it("approving a new_skill dedupes a colliding name with a -2 suffix", async () => {
    const mock = new MockCloud();
    const { sdk } = makeSdk(mock);
    await sdk.skills.create({ name: "taken", description: "d", body: "b" });
    const seeded = mock.seedSuggestion({
      type: "new_skill",
      patch: { name: "taken", description: "d", tags: [], body: "b", model: "m" },
    });
    const approved = await sdk.suggestions.approve(seeded.id);
    const skill = await sdk.skills.get(approved.createdSkillId as string);
    expect(skill.name).toBe("taken-2");
  });

  it("approving an edit_skill applies the patch through the version CAS", async () => {
    const mock = new MockCloud();
    const { sdk } = makeSdk(mock);
    const target = await sdk.skills.create({ name: "target", description: "old", body: "b" });
    const seeded = mock.seedSuggestion({
      type: "edit_skill",
      targetSkillId: target.id,
      targetSkillExpectedVersion: target.version,
      patch: { description: "improved" },
    });

    await sdk.suggestions.approve(seeded.id);
    const after = await sdk.skills.get(target.id);
    expect(after.description).toBe("improved");
    expect(after.version).toBe(target.version + 1);
  });

  it("approving an edit_skill against a stale version fails with version_conflict", async () => {
    const mock = new MockCloud();
    const { sdk } = makeSdk(mock);
    const target = await sdk.skills.create({ name: "target", description: "old", body: "b" });
    const seeded = mock.seedSuggestion({
      type: "edit_skill",
      targetSkillId: target.id,
      targetSkillExpectedVersion: target.version,
      patch: { description: "improved" },
    });
    await sdk.skills.update(target.id, { expectedVersion: target.version, body: "moved on" });

    await expect(sdk.suggestions.approve(seeded.id)).rejects.toMatchObject({
      code: "conflict",
      reason: "version_conflict",
    });
  });

  it("reject flips pending → rejected; a second review hits not_pending", async () => {
    const mock = new MockCloud();
    const seeded = mock.seedSuggestion({});
    const { sdk } = makeSdk(mock);

    const rejected = await sdk.suggestions.reject(seeded.id);
    expect(rejected.status).toBe("rejected");
    expect(rejected.reviewedAt).not.toBeNull();

    await expect(sdk.suggestions.approve(seeded.id)).rejects.toMatchObject({
      code: "conflict",
      reason: "not_pending",
    });
  });

  it("unknown suggestion id maps to not_found", async () => {
    const { sdk } = makeSdk();
    await expect(sdk.suggestions.approve("sug_missing")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
