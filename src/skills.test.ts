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

describe("SkillsClient", () => {
  it("round-trips a searchable description through create, get, update, and clear", async () => {
    const { sdk } = makeSdk();
    const created = await sdk.skills.create({
      name: "deploy-checklist",
      description: "How to deploy safely.",
      searchableDescription: "release production rollback canary",
      body: "# Deploy\n…",
    });
    expect(created.searchableDescription).toBe("release production rollback canary");

    const fetched = await sdk.skills.get(created.id);
    expect(fetched.searchableDescription).toBe("release production rollback canary");

    const updated = await sdk.skills.update(created.id, {
      expectedVersion: fetched.version,
      searchableDescription: "deploy production safely",
    });
    expect(updated.searchableDescription).toBe("deploy production safely");

    const cleared = await sdk.skills.update(created.id, {
      expectedVersion: updated.version,
      searchableDescription: null,
    });
    expect(cleared.searchableDescription).toBeNull();
  });

  it("creates a draft and reads it back via get and list", async () => {
    const { sdk } = makeSdk();
    const created = await sdk.skills.create({
      name: "deploy-checklist",
      description: "How to deploy safely.",
      body: "# Deploy\n…",
      tags: ["ops"],
    });
    expect(created.status).toBe("draft");
    expect(created.version).toBe(1);

    const fetched = await sdk.skills.get(created.id);
    expect(fetched.name).toBe("deploy-checklist");

    const listed = await sdk.skills.list({ status: "draft" });
    expect(listed.count).toBe(1);
    expect(listed.skills[0]?.id).toBe(created.id);
  });

  it("rejects a non-kebab-case name", async () => {
    const { sdk } = makeSdk();
    await expect(
      sdk.skills.create({ name: "Not Kebab", description: "d", body: "b" }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("rejects a duplicate active name with name_conflict", async () => {
    const { sdk } = makeSdk();
    await sdk.skills.create({ name: "dupe", description: "d", body: "b" });
    await expect(
      sdk.skills.create({ name: "dupe", description: "d2", body: "b2" }),
    ).rejects.toMatchObject({ code: "conflict", reason: "name_conflict" });
  });

  it("updates through the version CAS and bumps the version", async () => {
    const { sdk } = makeSdk();
    const skill = await sdk.skills.create({ name: "s", description: "old", body: "b" });

    await expect(
      sdk.skills.update(skill.id, { expectedVersion: 99, description: "new" }),
    ).rejects.toMatchObject({ code: "conflict", reason: "version_conflict" });

    const updated = await sdk.skills.update(skill.id, {
      expectedVersion: skill.version,
      description: "new",
    });
    expect(updated.description).toBe("new");
    expect(updated.version).toBe(skill.version + 1);
  });

  it("applies an unguarded update unconditionally when expectedVersion is omitted", async () => {
    const { sdk } = makeSdk();
    const skill = await sdk.skills.create({ name: "s", description: "old", body: "b" });
    // Someone else edits first — an unguarded write still lands on top.
    await sdk.skills.update(skill.id, { expectedVersion: skill.version, description: "theirs" });

    const updated = await sdk.skills.update(skill.id, { description: "mine" });
    expect(updated.description).toBe("mine");
    expect(updated.version).toBe(skill.version + 2);
  });

  it("publishes and archives unguarded when expectedVersion is omitted", async () => {
    const { sdk } = makeSdk();
    const skill = await sdk.skills.create({ name: "s", description: "d", body: "b" });

    const published = await sdk.skills.publish(skill.id);
    expect(published.status).toBe("published");

    const archived = await sdk.skills.archive(skill.id);
    expect(archived.status).toBe("archived");
  });

  it("still rejects a stale guard on publish", async () => {
    const { sdk } = makeSdk();
    const skill = await sdk.skills.create({ name: "s", description: "d", body: "b" });
    await expect(sdk.skills.publish(skill.id, { expectedVersion: 99 })).rejects.toMatchObject({
      code: "conflict",
      reason: "version_conflict",
    });
  });

  it("publish moves a skill into the published set; archive removes it", async () => {
    const { sdk } = makeSdk();
    const skill = await sdk.skills.create({ name: "pub-me", description: "d", body: "b" });

    const published = await sdk.skills.publish(skill.id, { expectedVersion: skill.version });
    expect(published.status).toBe("published");
    expect(published.publishedAt).not.toBeNull();

    let listed = await sdk.skills.list({ status: "published" });
    expect(listed.skills.map((s) => s.name)).toContain("pub-me");

    await sdk.skills.archive(skill.id, { expectedVersion: published.version });
    listed = await sdk.skills.list({ status: "published" });
    expect(listed.skills.map((s) => s.name)).not.toContain("pub-me");
  });

  it("scopes a skill to an end user and filters list by it", async () => {
    const { sdk } = makeSdk();
    await sdk.skills.create({ name: "for-alice", description: "d", body: "b", endUserId: "alice" });
    await sdk.skills.create({ name: "global", description: "d", body: "b" });

    const alices = await sdk.skills.list({ endUserId: "alice" });
    expect(alices.skills.map((s) => s.name)).toEqual(["for-alice"]);
  });

  it("import reports created / updated / unchanged by name", async () => {
    const { sdk } = makeSdk();
    await sdk.skills.create({ name: "keep", description: "same", body: "same" });
    await sdk.skills.create({ name: "change", description: "old", body: "old" });

    const report = await sdk.skills.import([
      { name: "keep", description: "same", body: "same" },
      { name: "change", description: "new", body: "new" },
      { name: "fresh", description: "d", body: "b" },
    ]);
    expect(report).toEqual({ created: ["fresh"], updated: ["change"], unchanged: ["keep"] });
  });

  it("get of an unknown id maps to not_found", async () => {
    const { sdk } = makeSdk();
    await expect(sdk.skills.get("sk_missing")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });
});
