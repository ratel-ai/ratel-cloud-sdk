# Changelog

## 0.2.0 (unreleased)

Tracks ratel-cloud #36, which makes the intent flow asynchronous.

### Breaking

- `intents.analyze` no longer drafts skills or returns `suggestionIds` — it extracts intents and
  scores coverage only. Drafting is now the explicit async sequence
  `intents.suggest(intentId) → jobs.waitFor(jobId) → suggestions.get(suggestionId)`.

### Added

- `intents.list()` — the recurring-ask ledger (`GET /intents`, paged).
- `intents.suggest(intentId)` — enqueue a per-intent drafting job (`→ { jobId }`).
- `jobs.*` — new client: `jobs.get(id)` / `jobs.waitFor(id)` to poll async jobs to completion.
- `suggestions.get(id)` — fetch one proposal by id.
- Request/response logging — `debug: true` (console) or a custom `logger` sink on the client;
  emits structured `CloudSdkLogEvent`s (never the auth header).

## 0.1.0

Initial release.

- `RatelCloudSdk` — Bearer-authed client over the Ratel Cloud v1 API.
- `skills.*` — managed-catalog CRUD, publish/archive lifecycle, optional version CAS, bulk
  `import`.
- `intents.analyze` — conversation → intents → coverage → gap suggestions (drafted inline).
- `suggestions.*` — list/generate/approve/reject.
- `@ratel-ai/cloud-sdk/testing` — `MockCloud`, an in-process mock of the v1 surface.
- Vendored `protocol/v1` conformance vectors, reproduced byte-for-byte in tests.
