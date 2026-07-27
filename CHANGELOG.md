# Changelog

## 0.1.0 (unreleased)

Initial release.

- `RatelCloudSdk` — Bearer-authed client over the Ratel Cloud v1 API.
- `skills.*` — managed-catalog CRUD, publish/archive lifecycle, optional version CAS, bulk
  `import`.
- `intents.*` — the async intent flow: `analyze` (conversation → intents + coverage; **no
  drafting**), `list` (the recurring-ask ledger), `suggest` (enqueue a per-intent drafting job).
- `jobs.*` — `get` / `waitFor` to poll async jobs (e.g. a `suggest` job) to completion.
- `suggestions.*` — get/list/generate/approve/reject.
- `@ratel-ai/cloud-sdk/testing` — `MockCloud`, an in-process mock of the v1 surface.
- Vendored `protocol/v1` conformance vectors, reproduced byte-for-byte in tests.

Note: `intents.analyze` no longer drafts skills or returns `suggestionIds`; drafting is the
explicit `intents.suggest → jobs.waitFor → suggestions.get` sequence (tracks ratel-cloud #36).
