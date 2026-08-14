# @ratel-ai/cloud-sdk

Management & supervised self-improvement client for [Ratel Cloud](https://cloud.ratel.sh): manage a project's
**cloud skills catalog**, run **intent analysis** on conversations, and review the resulting
**skill suggestions** — over the v1 HTTP API, authenticated by a project API key.

```sh
npm install @ratel-ai/cloud-sdk
```

## Quickstart

```ts
import { RatelCloudSdk, type SuggestJobResult } from "@ratel-ai/cloud-sdk";

const cloud = new RatelCloudSdk({ apiKey: process.env.RATEL_API_KEY! });

// — Catalog management —
const skill = await cloud.skills.create({
  name: "deploy-checklist",
  description: "How to deploy safely.",
  body: "# Deploy\n…",
});
await cloud.skills.publish(skill.id, { expectedVersion: skill.version });

// — Supervised self-improvement (async: analyze → suggest → poll → review) —
const run = await cloud.intents.analyze({
  messages: [{ role: "user", content: "how do I rotate the database credentials?" }],
  endUserId: "user-123",
});
for (const intent of run.intents.filter((i) => !i.covered)) {
  const { jobId } = await cloud.intents.suggest(intent.id); // draft a skill (async)
  const job = await cloud.jobs.waitFor<SuggestJobResult>(jobId); // poll until it's done
  if (job.result?.suggestionId) {
    await cloud.suggestions.approve(job.result.suggestionId); // lands as a draft skill
  }
}
```

## Client setup

```ts
const cloud = new RatelCloudSdk({
  apiKey: "rtl_…",                              // required — sent as `Authorization: Bearer`
  baseUrl: "https://cloud.ratel.sh/api/v1",     // default; include the /api/v1 prefix
  timeoutMs: 30_000,                            // default per-request timeout
  fetch: customFetch,                           // injectable (testing, proxies, instrumentation)
  debug: true,                                  // log each request + response to the console
});
```

## Runtime events and catalog snapshots

Use the `/runtime` subpath to stream Ratel SDK runtime facts and publish its complete tool catalog.
Set `RATEL_API_KEY`, then attach once after creating the Ratel runtime:

```ts
import { ratel } from "@ratel-ai/sdk";
import * as ratelCloud from "@ratel-ai/cloud-sdk/runtime";

const runtime = ratel();
const cloudRuntime = ratelCloud.attach(runtime);
```

`attach()` subscribes to search, invocation, registration, and experiment facts. It publishes an
initial catalog snapshot and refreshes it after tool registration churn. Repeated calls
with the same runtime return the same handle. `sourceId` defaults to the runtime's stable OTel
`service.name`; override it only with another stable deployment identity:

```ts
const cloudRuntime = ratelCloud.attach(runtime, { sourceId: "checkout-worker" });
```

Catalog failures remain queued with backoff, and durable snapshots reconcile every five minutes.
Tune those windows with `snapshotDebounceMs` and `snapshotReconcileIntervalMs`.

Set `RATEL_CLOUD_EVENTS=off` before calling `attach()` to disable event delivery. Catalog snapshots
remain enabled; the events publisher reads this kill switch once when the attachment is created.

Delivery is fail-open and in memory. On long-running processes, call `close()` during final
shutdown to unsubscribe and drain accepted work. In serverless handlers, keep the attachment for
warm invocations and explicitly `flush()` before each invocation ends:

```ts
export async function handler(request: Request) {
  try {
    return await handleRequest(request, runtime);
  } finally {
    await cloudRuntime.flush();
  }
}

process.once("SIGTERM", () => void cloudRuntime.close());
```

Pass `onRejected` to observe terminal event delivery failures, Cloud event rejects, and catalog
tools omitted by client-side snapshot limits. Snapshot publication matches Cloud's limits: 5,000
tools and a 4,000,000-byte body; IDs/names are trimmed to 512 characters and descriptions to
16,384 characters. A degraded `202 { synced: false }` remains pending for a later retry.

The cross-repository live acceptance test is opt-in with `RATEL_E2E=1`; see the
[runtime attach E2E example](./examples/README.md#runtime-attach-e2emjs--live-runtime-attach-acceptance).

Set `debug: true` to log every call — `→ GET /skills?status=published` on the way out, `← 200 …`
with the parsed response body on the way back (the auth header is never logged). For structured
logging, pass a `logger: (event: CloudSdkLogEvent) => void` sink instead (it takes precedence over
`debug`); each event is a `request`, `response` (with `status`, `durationMs`, `body`), or `error`.

Some calls override `timeoutMs` with a budget of their own — `suggestions.generate` (5 min) and
`intents.analyze` (2 min); everything else uses yours. Drafting itself is an async job you poll
(`jobs.waitFor`), so no single request blocks on the model.

The transport does **no retries**: mutations are not idempotent, and reads are cheap to re-issue
at your discretion. A request that never gets a response (DNS failure, abort, timeout) throws a
`CloudSdkError` with `code: "network_error"` and `status: null` — see [Errors](#errors).

---

## API reference

### `cloud.skills` — managed-catalog write surface

Skills live in one project and move through `draft → published → archived`. Every mutation
supports **opt-in optimistic concurrency**: pass the `version` you last read as
`expectedVersion` and a stale value throws `conflict (version_conflict)` with nothing written;
omit it and the write applies unconditionally (last write wins). Pass it whenever your edit was
derived from a read — skip it only for writes that don't depend on current content (cleanup
scripts, forced overwrites).

#### `skills.list(options?) → { count, skills }`

```ts
const { skills } = await cloud.skills.list({ status: "draft" });
const theirs = await cloud.skills.list({ endUserId: "user-123" }); // one user's scoped skills
```

Filters: `status` (`"draft" | "published" | "archived"`), `endUserId`. No filter returns every
skill in the project, archived included.

#### `skills.get(id) → CloudSkill`

Throws `not_found` for unknown ids — including skills that never existed *and* ids from another
project (the server does not distinguish).

#### `skills.create(input) → CloudSkill`

```ts
const skill = await cloud.skills.create({
  name: "rotate-db-credentials",       // kebab-case, unique among non-archived skills
  description: "Rotate database credentials without downtime.",
  body: "# Rotation\n…",
  tags: ["ops"],                       // optional, default []
  tools: ["psql"],                     // optional, default []
  metadata: { runbook: ["db"] },       // optional, Record<string, string[]>
  status: "published",                 // optional — skip the draft stage entirely
  endUserId: "user-123",               // optional — scope to one end-user (see Scoping)
});
```

- `name` must be kebab-case (`^[a-z0-9]+(?:-[a-z0-9]+)*$`) — anything else is
  `invalid (invalid_name)`.
- A name collision with any **non-archived** skill is `conflict (name_conflict)`. Archiving a
  skill frees its name for reuse.
- Default `status` is `"draft"`; `"archived"` is not a valid creation status (archive is a
  lifecycle transition, not a starting state).
- The returned skill carries `version: 1` — keep it for the next mutation.

#### `skills.update(id, { expectedVersion?, …fields }) → CloudSkill`

```ts
const next = await cloud.skills.update(skill.id, {
  expectedVersion: skill.version,      // guard the edit against concurrent writes
  body: "# Rotation (v2)\n…",
  name: "rotate-credentials",          // renames are allowed
});

await cloud.skills.update(skill.id, { tags: ["ops"] }); // unguarded: applies unconditionally
```

Partial edit: only the fields you pass change. `status` is deliberately **not** editable here —
use `publish`/`archive`. A rename that collides with a non-archived skill is
`conflict (name_conflict)`. Every successful update bumps `version` by 1, guarded or not.

#### `skills.publish(id, opts?)` / `skills.archive(id, opts?)`

Lifecycle transitions; `{ expectedVersion }` optionally guards them like an edit (they also bump
`version`). Publishing stamps `publishedAt` and makes the skill visible to the loader.
Archiving removes it from the published set and frees its name. An unguarded
`archive(id)` is the "just remove it" form for cleanup scripts; guard a `publish` when you want
to be sure nobody edited the body between your review and the call.

#### `skills.import(skills) → { created, updated, unchanged }`

Bulk **upsert-by-name** for onboarding an existing skill set — e.g. syncing from the store your
application already manages:

```ts
const rows = await db.query("SELECT name, description, body, tags FROM playbooks");
const report = await cloud.skills.import(
  rows.map((r) => ({ name: r.name, description: r.description, body: r.body, tags: r.tags })),
);
// → { created: ["deploy-checklist"], updated: ["rotate-db-credentials"], unchanged: [] }
```

- Matching is by `name` against non-archived skills; content comparison decides
  `updated` vs `unchanged`, so re-running an import is idempotent.
- Import **never archives**: a skill that exists in cloud but not in your input is left alone.
  Cloud is the source of truth — removal is an explicit `archive` call.
- Imported updates bump versions like any other edit; concurrent editors will see
  `version_conflict` on their next stale write, as expected.

Reading the *resolved published* catalog — the overlaid, published-only view an agent receives —
is deliberately not part of this client: that's the ratel SDK cloud loader's job. `list` gives
you the management rows; the loader serves the consumer view.

### `cloud.intents` — conversation analysis

The intent flow is **asynchronous**: `analyze` extracts intents and scores coverage but does
**not** draft skills. To draft one, call `intents.suggest(intentId)` — it enqueues a job you poll
with `cloud.jobs` — then fetch the drafted proposal with `suggestions.get`.

#### `intents.analyze(input) → AnalyzeResult`

```ts
const run = await cloud.intents.analyze({
  messages: [
    { role: "user", content: "how do I rotate the database credentials?" },
    { role: "assistant", content: "You can use the rotation runbook…" },
  ],
  endUserId: "user-123",         // optional — scope coverage to this user's overlaid catalog
  conversationId: "conv-42",     // optional — reference a conversation Cloud already ingested
});

run.intents.forEach((i) => {
  // { id, text, covered, matchedSkillId, score } — pass `i.id` to intents.suggest()
});
```

Extracts the user's intents and checks each against the published catalog (**coverage**). The
result:

| Field | Meaning |
|---|---|
| `runId` | Identifier of this analysis run |
| `cached` | `true` when the conversation was unchanged since the last run — the previous result is returned |
| `catalogVersion` | ETag hex of the catalog snapshot the verdicts were computed against |
| `intents` | Each extracted intent: `{ id, text, covered, matchedSkillId, score }`. `id` is a stable `query_intents` id — pass it to `intents.suggest` |

Re-analyzing an unchanged conversation is a server-side cache hit, so **calling `analyze` after
every turn is cheap** — the intended usage is exactly that, with `endUserId` set so coverage runs
against that user's overlaid catalog. Messages are role-tagged (`user | assistant | system |
tool`); extraction is driven by the user turns, with the rest as context. Analysis needs no model
key server-side.

Extraction never degrades: if the server's extractor is unconfigured or temporarily down,
`analyze` throws a `CloudSdkError` with code `"unavailable"` (reason `"extractor_not_configured"`
or `"extractor_unavailable"`) instead of returning made-up intents — retry later. For
testing/debugging, pass `noCache: true` to skip the stored-run cache and force a live
extraction; the fresh result replaces the stored run for that conversation.

#### `intents.list(options?) → ListIntentsResult`

```ts
const { intents, total, page, pageSize } = await cloud.intents.list({ page: 0 });
// intents: [{ id, text, occurrences, firstSeenAt, lastSeenAt }] — most-frequent first
```

The project's recurring-ask ledger. `page` is zero-based; the server serves 50 per page.

#### `intents.suggest(intentId) → { jobId, coalesced? }`

```ts
const { jobId } = await cloud.intents.suggest(intent.id);
```

Enqueues a drafting job for one intent id (from `analyze` or `list`) and returns immediately.
Poll it with `cloud.jobs` (below). Throws `not_found` if the intent isn't in your project.

### `cloud.jobs` — polling async jobs

#### `jobs.get(id) → Job` · `jobs.waitFor(id, opts?) → Job`

```ts
const job = await cloud.jobs.waitFor<SuggestJobResult>(jobId); // polls until done/error
// { id, kind: "suggest_skill", status, result, error }
if (job.result?.suggestionId) {
  const suggestion = await cloud.suggestions.get(job.result.suggestionId);
  await cloud.suggestions.approve(suggestion.id);     // lands as a draft skill
}
```

`status` is `queued | running | done | error`. For a `suggest_skill` job, a `done` result is
`{ suggestionId, reason? }`:

- a non-null `suggestionId` → fetch it with `suggestions.get`;
- `reason: "not_configured"` → the server has no drafting key (`ANTHROPIC_API_KEY`);
- `reason: "exists"` → a pending or approved suggestion for this intent already exists
  (a rejected one doesn't count — the intent can be re-drafted).

`waitFor` polls at `intervalMs` (default 1 s) until the job is terminal or `timeoutMs` (default
2 min) elapses; it returns the terminal job (it does **not** throw on `status: "error"` — inspect
`job.error`), throwing only on transport failures or timeout. The timeout throw is a
`CloudSdkError` with `code: "unavailable"` and `reason: "poll_timeout"`, so it's distinguishable
from a real 503.

### `cloud.suggestions` — reviewing machine-drafted proposals

Suggestions are proposals the self-improvement pipeline drafts from usage signals
(`coverage_gap`, `surfaced_not_invoked`, `tool_error`). Two types:

- **`new_skill`** — a full drafted skill for an uncovered intent; `patch` carries
  `{ name, description, tags, body, model }`.
- **`edit_skill`** — a partial patch (`description` / `tags` / `body`, never `name`) against
  `targetSkillId`, pinned to `targetSkillExpectedVersion`.

Each suggestion carries `rationale`, `evidence`, and a `retrievabilityPreview` (how
representative queries would rank before vs after applying), so a human can review without
reconstructing context.

#### `suggestions.get(id) → CloudSuggestion`

```ts
const suggestion = await cloud.suggestions.get(suggestionId); // e.g. a suggest job's suggestionId
```

Fetch one proposal by id — typically the `suggestionId` an `intents.suggest` job produced.

#### `suggestions.list(options?) → { count, suggestions }`

```ts
const pending = await cloud.suggestions.list({ status: "pending", limit: 100 });
```

Filters: `status` (`pending | approved | rejected | auto_applied | superseded`), `type`,
`endUserId`. `limit` is clamped to 1–100, default 50.

#### `suggestions.generate() → { jobId, coalesced }`

Triggers a generation run over accumulated signals. It **drains synchronously server-side** — a
resolved promise means `list()` already sees the results (hence the 5-minute timeout budget).
`coalesced: true` means an in-flight run absorbed this request; the results are still there when
it resolves. This is the batch sweep over signal kinds; per-intent drafting is `intents.suggest`.

#### `suggestions.approve(id)` / `suggestions.reject(id)`

Approving applies the proposal:

- a `new_skill` lands as a **draft** skill (inheriting the suggestion's `endUserId` scope) and
  the suggestion records it in `createdSkillId` — publish it like any other draft;
- an `edit_skill` applies to the target through the version CAS.

Both transitions require the suggestion to still be `pending`. State races throw `conflict` with
a `reason` telling you which one you lost — see the next section.

---

## Errors

Every non-2xx response throws a `CloudSdkError`:

```ts
try {
  await cloud.skills.update(id, { expectedVersion, body });
} catch (err) {
  if (err instanceof CloudSdkError && err.code === "conflict") {
    // err.reason === "version_conflict" here
  } else throw err;
}
```

| `code` | Typical status | Meaning |
|---|---|---|
| `unauthorized` | 401 | Missing/invalid/revoked API key |
| `forbidden` | 403 | Key valid, operation not allowed |
| `not_found` | 404 | Unknown id/route (or another project's resource) |
| `conflict` | 409 | State race — inspect `reason` |
| `invalid` | 400 | Malformed input — `reason` may say which rule (e.g. `invalid_name`, `invalid_status`) |
| `quota_exceeded` | 402 / 429 | Plan quota or rate limit |
| `unavailable` | 503 | Transient server condition |
| `server_error` | 5xx | Unexpected server failure |
| `network_error` | — (`status: null`) | No response: DNS/connection failure, abort, timeout |

The `conflict` reasons on this surface:

| `reason` | Thrown by | Meaning |
|---|---|---|
| `version_conflict` | `skills.update/publish/archive` (when guarded), `suggestions.approve` (edit) | `expectedVersion` (or the suggestion's pinned target version) is stale |
| `name_conflict` | `skills.create/update` | Name already used by a non-archived skill |
| `not_pending` | `suggestions.approve/reject` | The suggestion was already reviewed (or superseded) |

## Edge cases & recipes

### Retrying a lost version race

`version_conflict` means someone (a teammate, an approved suggestion, an import) wrote the skill
after you read it. Re-read, re-apply your edit on top, retry:

```ts
async function updateWithRetry(id: string, edit: { body: string }, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const current = await cloud.skills.get(id);
    try {
      return await cloud.skills.update(id, { expectedVersion: current.version, ...edit });
    } catch (err) {
      const lostRace =
        err instanceof CloudSdkError && err.code === "conflict" && err.reason === "version_conflict";
      if (!lostRace || i === attempts - 1) throw err;
    }
  }
  throw new Error("unreachable");
}
```

Only blind field overwrites are safe to auto-retry like this — if your edit depended on the
content you read (e.g. appending to the body), recompute it from `current` each iteration.

### Approving suggestions defensively

A review queue processed by two operators — or re-processed after a partial failure — will hit
state races. Treat them as outcomes, not failures:

```ts
for (const s of pending.suggestions) {
  try {
    await cloud.suggestions.approve(s.id);
  } catch (err) {
    if (!(err instanceof CloudSdkError) || err.code !== "conflict") throw err;
    switch (err.reason) {
      case "not_pending":
        break; // someone else already reviewed it — nothing to do
      case "version_conflict":
        // the target skill changed since this edit was drafted; the patch may no
        // longer apply cleanly. Reject and let the next analysis re-draft it.
        await cloud.suggestions.reject(s.id);
        break;
      default:
        throw err;
    }
  }
}
```

### Per-end-user personalization, end to end

`endUserId` is an opaque id (same id space as telemetry). Skills scoped to it overlay the global
layer — same `name` ⇒ the scoped skill wins for that user, everyone else keeps the global one:

```ts
// Tailor the global "deploy-checklist" for one user:
await cloud.skills.create({
  name: "deploy-checklist",            // same name as the global skill — no conflict:
  endUserId: "user-123",               // scoping makes the pair coexist
  description: "Deploy checklist for the EU cluster.",
  body: "# EU deploy\n…",
  status: "published",
});

// Agents synced with scope "user-123" get the overlaid view; everyone else is untouched.
// Analysis with the same id sees the overlaid catalog too, and a skill drafted from one of its
// intents (intents.suggest) inherits the scope:
await cloud.intents.analyze({ messages, endUserId: "user-123" });
```

### Name lifecycle gotchas

- Uniqueness is enforced only among **non-archived** skills: archive `foo`, and a new `foo` can
  be created. The archived row keeps its id and history.
- `skills.import` never deletes: removing a skill from your source data does *not* archive it
  in cloud on the next import. Archive explicitly.
- `edit_skill` suggestions never propose renames; renames are always a deliberate
  `skills.update`.

### Timeouts, aborts, and re-issue policy

All failures-to-respond surface as `code: "network_error"` with `status: null` — including the
client-side timeout. There is **no built-in retry**. Reads (`list`, `get`, and suggestion
lists) are always safe to re-issue. For mutations, prefer re-reading state over blind
retries: a timed-out `create` may still have committed server-side, and re-issuing it will
surface as `name_conflict` — which is your signal to `list` and reconcile rather than a bug.

---

## Telemetry — `@ratel-ai/cloud-sdk/otel`

Ratel Cloud's usage signals — the ones behind `suggestions.generate` — are fed by OpenTelemetry.
This package ships that destination as one composable span processor on a **subpath**, so the root
import stays dependency-free for consumers who only manage a catalog:

```sh
npm install @opentelemetry/api @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-proto
```

They are declared as **optional peer dependencies**: a missing one fails at import, not halfway
through a request.

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { RatelSpanProcessor } from "@ratel-ai/cloud-sdk/otel";

const sdk = new NodeSDK({
  spanProcessors: [
    new RatelSpanProcessor(),    // → Ratel Cloud
    ...yourExistingProcessors,   // Langfuse, a generic OTLP exporter, … keep working untouched
  ],
});
sdk.start();
```

**You own the provider.** Ratel ships no bootstrap, registers nothing globally, and installs no
`ContextManager`; `service.name` and flush/shutdown belong to your host. The processor is thin
sugar over a standard `BatchSpanProcessor` + OTLP exporter — Cloud defaults plus a filter.

### What gets sent

The default filter forwards only signal-bearing spans: a `ratel.*` span name, or any attribute
key under `gen_ai.*` / `ratel.*`. Your framework's wrapper noise (`ai.generateText`, HTTP
auto-instrumentation) is dropped.

One narrow exception covers the Vercel AI SDK, whose telemetry predates the GenAI semconv and
sits entirely under `ai.*` — spans Ratel Cloud normalizes on ingest, so they are signal that
simply doesn't say so in a key. `aiSdkSignalFilter` (exported, and composed into the default)
admits exactly the `ai.toolCall` span and the **chat model** spans: an `ai.`-prefixed name
containing `doGenerate` or `doStream` — `ai.generateText.doGenerate`, `ai.streamText.doStream`,
`ai.generateObject.doGenerate`, `ai.streamObject.doStream`. Two things stay out, for two
different reasons:

- The `ai.streamText` / `ai.generateText` **wrappers** duplicate the whole prompt of the model
  span beneath them (~100 KB per call, so roughly double the egress), and Cloud would read them
  as a second anchor for the same LLM call and double-count its tokens.
- `ai.embed.doEmbed`, `ai.embedMany.doEmbed`, and `ai.rerank.doRerank` are the **wrong
  operation**: Cloud stamps `gen_ai.operation.name = "chat"` on every model span it accepts, so
  these would ingest as phantom chat completions with no messages and no tools.

**Emission and delivery are separate.** Every span reaches every processor on the provider
intact; each destination's filter then decides independently. A span Ratel keeps may be dropped
by your vendor's processor and vice versa — and nothing in the logs will say so. Override per
instance with `spanFilter` (`() => true` forwards everything):

```ts
new RatelSpanProcessor({ spanFilter: (span) => span.name.startsWith("ratel.") });
```

Note the filter keys on span *name* and *attribute keys*, never on the emitting scope: both the
Ratel SDK and `@ai-sdk/otel` emit an `execute_tool <id>` span, and `gen_ai.*` attributes appear on
both. Ratel Cloud wants the GenAI signal whoever produced it.

> **Watch your attribute namespaces.** *Any* `ratel.*` attribute key opts a span in — including
> one you added for your own bookkeeping. Tag incidental attributes outside `ratel.*` (and outside
> `gen_ai.*`) unless you actually mean to send that span to Cloud.

**Captured content rides along.** When content capture is enabled, the
`gen_ai.client.inference.operation.details` EventRecord is a span event on the inference span, and
Cloud reads it from there. Forwarding the span forwards the captured messages with it — there is
nothing extra to wire up, and no separate Logs processor, because Cloud consumes no OTLP Logs
signal.

### Endpoint and auth

The route derives from the same `baseUrl` the management client uses, so one value points both
halves of the SDK at one deployment:

| Setting | Resolution order |
|---|---|
| Traces URL | `endpoint` → `RATEL_OTLP_ENDPOINT` → `${baseUrl}/traces` (default `https://cloud.ratel.sh/api/v1/traces`) |
| Auth | `apiKey` → an `Authorization` header you passed → `RATEL_API_KEY` |

Code-level config always beats ambient environment, and the `RATEL_API_KEY` fallback never
clobbers an `Authorization` header you set on purpose. Point `RATEL_OTLP_ENDPOINT` at any OTLP
backend to use this processor without Ratel Cloud at all.

Export is OTLP `http/protobuf`. Cloud accepts both protobuf and JSON, and replies `202 Accepted`.

### Turning it off

`enabled: false` is a strict no-op: no endpoint or auth resolution, no environment read, no
exporter, no baggage copying. Leave the wiring in place and flip the flag.

```ts
new RatelSpanProcessor({ enabled: process.env.NODE_ENV === "production" });
```

### Experiment arm stamping

Baggage keys under `ratel.experiment.*` are copied onto every span as attributes at `onStart`,
so experiment arms travel with whatever your framework emits. This requires your host to have a
`ContextManager` registered for baggage to propagate at all — the processor reads the host's
context and never registers one of its own.

One deliberate consequence: the attributes are written onto the **shared** span, so every
processor on the provider sees them, not only Ratel's. That is what makes arm stamping
framework-agnostic.

### Correlation

Spans join one trace only under an active host span. HTTP auto-instrumentation usually supplies
that context; jobs, cron entrypoints, and other uninstrumented callers must create it themselves,
or each span becomes its own root trace.

## Testing with `MockCloud`

Your application's test suite shouldn't need a live API key, network access, or quota.
`@ratel-ai/cloud-sdk/testing` (Node-only) ships `MockCloud` — an in-process, fetch-compatible
mock of the whole v1 surface, the same one this SDK's own test suite runs against. Routes,
status codes, and error bodies mirror the server, which matters most for the failure modes you
can't provoke against production on demand: version races, review races, auth errors — all the
error-handling paths documented above become three-line test cases.

```ts
import { RatelCloudSdk, CloudSdkError } from "@ratel-ai/cloud-sdk";
import { MockCloud } from "@ratel-ai/cloud-sdk/testing";

const mock = new MockCloud({
  catalog: {
    global: [{ id: "sk_1", name: "deploy-checklist", description: "…", tags: [], tools: [], metadata: {}, body: "…" }],
    subjects: { "user-123": [/* per-user layer */] },
  },
  suggestions: [{ type: "new_skill", status: "pending" }],   // partials are filled with defaults
  now: () => "2026-01-01T00:00:00.000Z",                     // injectable clock
});

const cloud = new RatelCloudSdk({ apiKey: mock.apiKey, fetch: mock.fetch });

// State is inspectable for assertions:
mock.skills;        // Map<id, CloudSkill>
mock.suggestions;   // Map<id, CloudSuggestion>
```

What to know when asserting against it:

- Seeded catalog skills are inserted as **published**; a wrong Bearer key gets a 401 like the
  real API.
- The mock's `GET /catalog` route (the loader's read path) computes ETags with the real
  `protocol/v1` canonicalization, so loader-side integration tests behave faithfully too.
- The intent **extraction** is a deterministic fixture, not the server pipeline: one intent per
  unique `user` message, covered iff some published skill's name tokens all appear in the
  message text. Don't assert on extraction quality — assert on your handling of the results.
- The async flow is faithful but instant: `intents.suggest` creates a job that is already `done`,
  so `jobs.waitFor` returns on the first poll. It drafts a `new_skill` suggestion (deduped like
  the server: a second `suggest` for an intent with a pending or approved draft returns
  `reason: "exists"`; a rejected draft doesn't suppress re-drafting).

## Protocol conformance

The catalog wire shape and ETag algorithm are the frozen `protocol/v1` contract. This package
vendors the protocol's conformance vectors and reproduces them byte-for-byte in `wire.test.ts`.
The pure canonicalization helpers are exported for tools that need to compute or verify catalog
identity themselves:

```ts
import { canonicalSet, resolve, ifNoneMatchMatches } from "@ratel-ai/cloud-sdk";
import { createHash } from "node:crypto";

const skills = resolve(catalog, "user-123");            // overlay a scope on the global layer
const etagHex = createHash("sha256")
  .update(canonicalSet(skills), "utf8")
  .digest("hex");                                       // == the server's catalogVersion
ifNoneMatchMatches(`"${etagHex}"`, currentEtag);        // RFC 7232 weak comparison
```

The hashing step is intentionally left to you — the helpers are pure string/byte functions with
no crypto dependency, so the module runs on any runtime.

## Related packages

This package covers the management side of Ratel Cloud, plus the telemetry destination above.
The catalog runtime lives elsewhere:

- **`@ratel-ai/cloud`** (ratel repo) — the loader that syncs published skills into a running
  agent (replica, refresh, ownership). This SDK deliberately keeps no runtime replica of the
  catalog; agents should sync through the loader. The two share only the API key.
- **`@ratel-ai/sdk`** and **`@ratel-ai/vercel-ai-sdk`** (ratel repo) — the *emit* side. They
  produce the `ratel.*` and `gen_ai.*` spans that `@ratel-ai/cloud-sdk/otel` consumes. Emission
  needs no Ratel telemetry package at all: the SDK emits standard OTel onto whatever provider you
  registered, and this package is only one possible destination for it.

## License

MIT © Agentified
