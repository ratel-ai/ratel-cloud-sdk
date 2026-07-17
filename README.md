# @ratel-ai/cloud-sdk

Management & intelligence client for [Ratel Cloud](https://cloud.ratel.sh): manage a project's
**cloud skills catalog**, run **intent analysis** on conversations, and review the resulting
**skill suggestions** — over the v1 HTTP API, authenticated by a project API key.

Pure `fetch`, zero runtime dependencies, no native addon. Runs in Node ≥ 20, edge runtimes, CI.

## Scope — and what this package is *not*

| Concern | Package |
|---|---|
| Manage the catalog, analyze conversations, review suggestions | **this package** |
| Sync published skills into a running agent (replica, refresh, ownership) | `@ratel-ai/cloud` loader (ratel repo) |
| Send LLM-call telemetry | telemetry client (ratel repo) |

This package deliberately does **not** keep a runtime replica of the catalog — agents should use
the loader for that. The two share only the API key.

## Usage

```ts
import { RatelCloudSdk } from "@ratel-ai/cloud-sdk";

const cloud = new RatelCloudSdk({ apiKey: process.env.RATEL_API_KEY! });

// — Catalog management —
const skill = await cloud.skills.create({
  name: "deploy-checklist",
  description: "How to deploy safely.",
  body: "# Deploy\n…",
});
await cloud.skills.publish(skill.id, { expectedVersion: skill.version });

// Onboard an existing SKILL.md folder (Node only):
import { readSkillsFromDir } from "@ratel-ai/cloud-sdk/node";
const report = await cloud.skills.import(await readSkillsFromDir("./skills"));

// Read-only pull (tooling/CI diffing; agents use the loader instead):
const pulled = await cloud.catalog.pull({ scope: "user-123" });

// — Intelligence loop —
const run = await cloud.intents.analyze({
  messages: [{ role: "user", content: "how do I rotate the database credentials?" }],
  endUserId: "user-123", // scopes coverage + drafted skills to this user
});

for (const id of run.suggestionIds) {
  await cloud.suggestions.approve(id); // gap drafts land as draft skills
}
```

Re-analyzing an unchanged conversation is a server-side cache hit (`cached: true`), so calling
`analyze` after every turn is cheap.

## Errors

Every non-2xx response throws a `CloudSdkError` with a stable `code`
(`unauthorized` | `not_found` | `conflict` | `invalid` | …) and, for state races, a finer
`reason` (`version_conflict` | `not_pending` | `name_conflict`). Skill mutations are
optimistic-concurrency guarded: pass the `version` you read as `expectedVersion`.

## Server availability

`catalog.pull` and `suggestions.*` are live on ratel-cloud today. The `skills.*` write surface
and `intents.analyze` are the ratel-cloud **S2/S3** milestones — this client implements their
frozen contracts, which `MockCloud` (below) also serves, so integration code can be built and
tested ahead of the server rollout.

## Testing your integration

```ts
import { MockCloud } from "@ratel-ai/cloud-sdk/testing";

const mock = new MockCloud({ catalog: { global: [/* WireSkill[] */] } });
const cloud = new RatelCloudSdk({ apiKey: mock.apiKey, fetch: mock.fetch });
```

`MockCloud` is an in-process, fetch-compatible mock of the v1 surface (Node only). Routes and
error bodies mirror the server; the intent *extraction* is a deterministic fixture, not the
server pipeline.

## Protocol conformance

The catalog wire shape and ETag algorithm are the frozen `protocol/v1` contract. This package
vendors the protocol's conformance vectors and reproduces them byte-for-byte in `wire.test.ts`;
the pure canonicalization helpers (`canonicalSkill`, `canonicalSet`, `resolve`,
`ifNoneMatchMatches`) are exported.
