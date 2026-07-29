# Examples

## `e2e.mjs` — end-to-end SDK walk

Exercises the client surface — skills lifecycle (create → get → list → update →
publish, including a version-conflict check), bulk import, conversation analysis
(with a cache-hit re-run), the recurring-ask intent ledger, and the async draft
flow (suggest → poll the job → fetch + approve the proposal) — then archives
everything it created so a live project is left clean. (Reading the published
catalog is the ratel cloud loader's job, not this client's, so there's no
catalog step.)

**Hybrid target**, chosen by whether `RATEL_API_KEY` is set:

| `RATEL_API_KEY` | Target | Network |
| --- | --- | --- |
| unset | in-process `MockCloud` (from `@ratel-ai/cloud-sdk/testing`) | none |
| set | the real cloud (`RATEL_BASE_URL`, or `https://cloud.ratel.sh/api/v1`) | yes |

```bash
pnpm run build          # the example imports the built package

pnpm run example:e2e    # mock — no credentials, no network

RATEL_API_KEY=rtl_… pnpm run example:e2e
RATEL_API_KEY=rtl_… RATEL_BASE_URL=https://my-host/api/v1 pnpm run example:e2e
```

Each step prints a `✓`/`✗` line; the process exits non-zero if any step fails,
so it doubles as a smoke test in CI against a live staging project.

Set `RATEL_DEBUG=1` (either example) to also log every SDK request + response —
`→ POST /intents/analyze` … `← 200 …` with the parsed body — so you can see
exactly which endpoints are hit:

```bash
RATEL_DEBUG=1 RATEL_API_KEY=rtl_… pnpm run example:ui   # logs in the server console
RATEL_DEBUG=1 pnpm run example:e2e
```

## `ui/` — analyze & review console

A tiny web UI for the human-in-the-loop half of the SDK: paste a conversation,
**analyze** it (extracted intents + per-intent coverage verdicts), click
**Suggest a skill** on a gap to run the async draft flow (suggest → poll the job
→ fetch the proposal), then review the drafted skill in full — name, description,
tags, body — **editing it before accepting**.

A proposal itself is immutable; there is no "update suggestion" endpoint. Editing
before accepting works because approving is not publishing: an approved
`new_skill` lands as a **draft** skill, so the reviewer's edits go on top of it
and only then does it publish. `POST /api/suggestions/{id}/accept` runs that
sequence and reports the calls it made, which the UI shows on the reviewed
intent:

```
✓ sdk.suggestions.approve("sug_16") → approved
✓ sdk.skills.get("sk_18") → v1 (draft)
✓ sdk.skills.update("sk_18", { name, tags }) → v2   # only the fields you changed
✓ sdk.skills.publish("sk_18") → published v3        # unchecked "Publish" stops at v2
```

Those steps cross the wire as `{ call, result }` (or `{ note }` for a call that
was skipped), so the page can render each one as the same signature chip it
shows beside the control that triggers it.

`ui/server.mjs` is a dependency-free `node:http` server that holds the project
key and proxies a narrow JSON API to the SDK; `ui/index.html` is the vanilla-JS
page it serves. **The `rtl_…` key stays on the server — the browser never sees
it.** Same hybrid target as `e2e.mjs`: no `RATEL_API_KEY` runs against a seeded
`MockCloud` (analysis, gap detection, and approval all work offline).

```bash
pnpm run build          # the server imports the built package

pnpm run example:ui     # mock — open http://localhost:8787
RATEL_API_KEY=rtl_… pnpm run example:ui
PORT=9000 RATEL_API_KEY=rtl_… RATEL_BASE_URL=https://host/api/v1 pnpm run example:ui
```

The **endUserId** picker above the analyze button scopes the run. Skills scoped
to an end-user overlay the global layer by `name`, so the same conversation
resolves differently per user: an intent that is a gap for everyone can be
covered by that user's own skill, and a covered one can match a *different*
skill id. Every skill and proposal card says which layer it lives in — `global`
or `scoped · <id>`. Two more consequences show up on screen: the recurring-ask
ledger is keyed on `(text, endUserId)`, so each user gets their own intent ids
and therefore their own proposals; and the analysis cache is keyed on the scope,
so switching users is never a `cached=true` hit.

The picker is the source of truth — a conversation pasted as
`{ messages, endUserId }` selects its id there rather than disagreeing with it.
Besides the two seeded test users, **Custom…** takes any opaque id, which is
what a live project needs. Offline, `MockCloud` is seeded with an `acme-eu`
layer (a `refund` that shadows the global one, plus `residency`) and an
`acme-us` layer (`warranty`), so the overlay is visible with no credentials.

A published skill isn't frozen, so the matched-skill card carries its own CTAs:
**Edit skill** applies `skills.update` under the version CAS, and **Archive**
(two-step, no browser dialog) retires it with `skills.archive`. Both send the
version the card was rendered from, so a stale editor loses with
`conflict / version_conflict` instead of overwriting a newer edit — and a save
refreshes every card showing that skill, not just the one you clicked.

The backend surface (all same-origin): `GET /api/mode`, `POST /api/analyze`,
`POST /api/intents/{id}/suggest`, `GET /api/intents/{id}/suggestion` (the
pending draft, when a job reports `reason: "exists"`), `GET /api/jobs/{id}`,
`GET /api/suggestions` (the ledger, so the page knows which intents already
have a draft), `GET /api/suggestions/{id}`, `GET`/`PATCH /api/skills/{id}`,
`POST /api/skills/{id}/{archive|publish}`, `POST
/api/suggestions/{id}/{approve|reject}`, and `POST /api/suggestions/{id}/accept`
— the only one that is more than a single SDK call.

> Note: on a live project, suggestion **drafting** needs `ANTHROPIC_API_KEY`
> server-side. Without it, analysis still returns intents and coverage verdicts,
> but the suggest job finishes with `result.reason: "not_configured"` — the UI
> shows that inline instead of a drafted suggestion.
