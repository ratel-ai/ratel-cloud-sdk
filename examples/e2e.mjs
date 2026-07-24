// End-to-end walk of the Ratel Cloud SDK surface.
//
// Hybrid target:
//   • RATEL_API_KEY set  → hits the real cloud (RATEL_BASE_URL or the default
//     https://cloud.ratel.sh/api/v1). A genuine end-to-end smoke test.
//   • RATEL_API_KEY unset → runs against the in-process MockCloud (no network,
//     no credentials) so the script is always runnable as a demo.
//
// It exercises the client surface — skills lifecycle (create → get → list →
// update → publish), bulk import, and conversation analyze (twice, to show the
// content-addressed cache) → suggestions review — and archives everything it
// created on the way out, so a live project is left clean.
//
// (Reading the published catalog is intentionally NOT part of this client — that
//  is the ratel cloud loader's job — so there is no catalog step here.)
//
//   node examples/e2e.mjs            # mock
//   RATEL_API_KEY=rtl_… node examples/e2e.mjs
//   RATEL_API_KEY=rtl_… RATEL_BASE_URL=https://my-host/api/v1 node examples/e2e.mjs
//
// Imports the built package, so run `pnpm run build` first (the npm script
// `pnpm run example:e2e` does not build for you).

import { RatelCloudSdk, CloudSdkError } from "../dist/index.js";
import { MockCloud } from "../dist/testing/index.js";

/* — tiny test harness ————————————————————————————————————————————————————— */

let stepNo = 0;
const failures = [];

async function step(name, fn) {
  stepNo += 1;
  const label = `${String(stepNo).padStart(2, "0")}  ${name}`;
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    console.log(`✓ ${label}${detail ? `  — ${detail}` : ""}  (${ms}ms)`);
  } catch (err) {
    const ms = Date.now() - started;
    failures.push({ name, err });
    const extra =
      err instanceof CloudSdkError
        ? ` [${err.code}${err.reason ? `/${err.reason}` : ""}${err.status ? ` ${err.status}` : ""}]`
        : "";
    console.log(`✗ ${label}${extra}  (${ms}ms)`);
    console.log(`     ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

/* — target selection —————————————————————————————————————————————————————— */

const apiKey = process.env.RATEL_API_KEY;
const baseUrl = process.env.RATEL_BASE_URL;
const live = Boolean(apiKey);

// A per-run suffix keeps skill names unique so re-runs against a live project
// never collide on `name_conflict`. Kebab-case, lowercase alphanumerics only.
const runId = Date.now().toString(36);
const NS = `sdk-e2e-${runId}`;

const sdk = live
  ? new RatelCloudSdk({ apiKey, ...(baseUrl ? { baseUrl } : {}) })
  : new RatelCloudSdk({ apiKey: "rtl_test_key", fetch: new MockCloud().fetch });

console.log(
  live
    ? `▶ LIVE  ${baseUrl ?? "https://cloud.ratel.sh/api/v1"}  (run ${runId})`
    : `▶ MOCK  in-process MockCloud  (run ${runId})`,
);
console.log("");

// Everything we create, so the `finally` block can archive it.
const createdIds = [];

/* — the walk —————————————————————————————————————————————————————————————— */

try {
  let skill;

  await step(`create skill "${NS}-refund" (draft)`, async () => {
    skill = await sdk.skills.create({
      name: `${NS}-refund`,
      description: "Issue a refund for a disputed charge.",
      body: "## When to use\nWhen a customer disputes a charge and qualifies for a refund.\n",
      tags: ["refund", "billing"],
      tools: ["refund_tool"],
      metadata: { stacks: ["stripe"] },
    });
    createdIds.push(skill.id);
    assert(skill.status === "draft", "new skill starts as draft");
    assert(skill.version === 1, "new skill starts at version 1");
    return `id=${skill.id} v${skill.version}`;
  });

  await step("get it back by id", async () => {
    const got = await sdk.skills.get(skill.id);
    assert(got.id === skill.id, "same id round-trips");
    assert(got.name === skill.name, "same name round-trips");
    return `status=${got.status}`;
  });

  await step("list drafts (filtered)", async () => {
    const { count, skills } = await sdk.skills.list({ status: "draft" });
    assert(
      skills.some((s) => s.id === skill.id),
      "our draft appears in the draft list",
    );
    return `count=${count}`;
  });

  await step("update description with expectedVersion CAS", async () => {
    const updated = await sdk.skills.update(skill.id, {
      expectedVersion: skill.version,
      description: "Issue a refund for a disputed charge, within policy.",
    });
    assert(updated.version === skill.version + 1, "version bumps on edit");
    skill = updated;
    return `v${updated.version}`;
  });

  await step("stale expectedVersion is rejected (409 version_conflict)", async () => {
    try {
      await sdk.skills.update(skill.id, { expectedVersion: 1, description: "stale write" });
      throw new Error("expected a version_conflict, but the update succeeded");
    } catch (err) {
      assert(err instanceof CloudSdkError, "throws a CloudSdkError");
      assert(err.code === "conflict", `code is conflict (got ${err.code})`);
      assert(err.reason === "version_conflict", `reason is version_conflict (got ${err.reason})`);
      return "correctly rejected";
    }
  });

  await step("publish", async () => {
    const published = await sdk.skills.publish(skill.id, { expectedVersion: skill.version });
    assert(published.status === "published", "status is published");
    assert(published.publishedAt !== null, "publishedAt is set");
    skill = published;
    return `v${published.version} publishedAt=${published.publishedAt}`;
  });

  await step("import (upsert-by-name): 1 update + 1 create", async () => {
    const report = await sdk.skills.import([
      {
        // same name as the published skill above, changed body → an update
        name: `${NS}-refund`,
        description: "Issue a refund for a disputed charge, within policy.",
        body: "## When to use\nUpdated via import.\n",
        tags: ["refund", "billing"],
        tools: ["refund_tool"],
      },
      {
        name: `${NS}-track-order`,
        description: "Look up the status of an order.",
        body: "## When to use\nWhen a customer asks where their order is.\n",
      },
    ]);
    assert(report.updated.includes(`${NS}-refund`), "existing skill is reported updated");
    assert(report.created.includes(`${NS}-track-order`), "new skill is reported created");
    // Track the imported create so cleanup can archive it too.
    const created = await sdk.skills.list({ status: "draft" });
    const trackOrder = created.skills.find((s) => s.name === `${NS}-track-order`);
    if (trackOrder) createdIds.push(trackOrder.id);
    return `created=${report.created.length} updated=${report.updated.length} unchanged=${report.unchanged.length}`;
  });

  let analyze1;
  await step("analyze conversation", async () => {
    analyze1 = await sdk.intents.analyze({
      messages: [{ role: "user", content: "how do I get a refund for my order?" }],
    });
    assert(typeof analyze1.runId === "string", "runId present");
    assert(Array.isArray(analyze1.intents), "intents is an array");
    assert(analyze1.cached === false, "first analyze is not cached");
    return `runId=${analyze1.runId} intents=${analyze1.intents.length} suggestions=${analyze1.suggestionIds.length} cv=${String(analyze1.catalogVersion).slice(0, 8)}`;
  });

  await step("re-analyze identical conversation → cache hit", async () => {
    const again = await sdk.intents.analyze({
      messages: [{ role: "user", content: "how do I get a refund for my order?" }],
    });
    assert(again.cached === true, "identical conversation is a cache hit");
    assert(again.runId === analyze1.runId, "cache hit returns the same run");
    return "cached=true";
  });

  await step("list pending suggestions", async () => {
    const { count, suggestions } = await sdk.suggestions.list({ status: "pending" });
    return `count=${count}${suggestions[0] ? ` first=${suggestions[0].type}/${suggestions[0].signalKind}` : ""}`;
  });
} finally {
  /* — cleanup: archive everything we created, so a live project stays clean — */
  if (createdIds.length) {
    console.log("");
    for (const id of createdIds) {
      await step(`cleanup: archive ${id}`, async () => {
        await sdk.skills.archive(id);
        return "archived";
      });
    }
  }
}

/* — verdict ——————————————————————————————————————————————————————————————— */

console.log("");
if (failures.length) {
  console.log(`✗ ${failures.length} step(s) failed against ${live ? "LIVE" : "MOCK"}.`);
  process.exit(1);
}
console.log(`✓ all steps passed against ${live ? "LIVE" : "MOCK"}.`);
