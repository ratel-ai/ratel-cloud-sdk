# Examples

## `e2e.mjs` — end-to-end SDK walk

Exercises the client surface — skills lifecycle (create → get → list → update →
publish), bulk import, conversation analysis (with a cache-hit re-run), and
suggestion listing — then archives everything it created so a live project is
left clean. (Reading the published catalog is the ratel cloud loader's job, not
this client's, so there's no catalog step.)

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

## `ui/` — analyze &amp; review console

A tiny web UI for the human-in-the-loop half of the SDK: paste a conversation,
**analyze** it (extracted intents + per-intent coverage verdicts), click
**Suggest a skill** on a gap to run the async draft flow (suggest → poll the job
→ fetch the proposal), and **approve / reject** what comes back.

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

The backend surface (all same-origin, each mapping to one SDK call): `GET
/api/mode`, `POST /api/analyze`, `POST /api/intents/{id}/suggest`, `GET
/api/jobs/{id}`, `GET /api/suggestions/{id}`, `POST
/api/suggestions/{id}/{approve|reject}`.

> Note: on a live project, suggestion **drafting** needs `ANTHROPIC_API_KEY`
> server-side. Without it, analysis still returns intents and coverage verdicts,
> but the suggest job finishes with `result.reason: "not_configured"` — the UI
> shows that inline instead of a drafted suggestion.
