# Changelog

## Unreleased

### Fixed

- **Runtime-authored Retrieval descriptions now reach Cloud.** `attach()` dropped
  `experimentalSearchableDescription` when mapping a catalog snapshot onto the wire, so a runtime
  that curated retrieval-only text published just its agent-facing prose and Cloud indexed the wrong
  half of the pair. It now travels as `searchable_description` on `PUT /v1/catalog/snapshot`.
  0.5.0 shipped the Cloud-owned direction (`useCloudDefinitions`) but left the runtime unable to
  publish its own, which made a Cloud override the only way to match on anything but the description.
  The key is omitted when unset or blank after trimming, so a publisher that has not adopted it
  sends a byte-identical body and keeps its catalog version. Requires Cloud to accept the field;
  older deployments ignore it and fall back to matching on the description.

## 0.5.0 - 2026-08-21

### Added

- **Cloud-owned Retrieval descriptions.** Managed skills now round-trip an optional
  `searchableDescription`; catalog protocol v2 exposes it with frozen canonicalization and ETag
  helpers. `cloud.runtimeCatalog.listOverrides()` pulls operator-authored runtime definition
  overrides with conditional ETag support, while `attach(runtime, { useCloudDefinitions: true })`
  applies and refreshes them through `@ratel-ai/sdk` >= 0.12.0 without making attach failures fatal.
- **OTLP Logs delivery.** `RatelLogRecordProcessor` forwards named `ratel.*` event records to
  Cloud's Logs endpoint, with independent filtering, endpoint configuration, and fail-closed
  disablement. It composes with host-owned OpenTelemetry providers like `RatelSpanProcessor`.
- **Catalog v2 test parity.** `MockCloud` serves v1 and v2 catalogs, conditional ETags, and seeded
  runtime-catalog overrides for integration tests.

### Changed

- Importing `@ratel-ai/cloud-sdk/otel` now also requires the optional
  `@opentelemetry/sdk-logs` and `@opentelemetry/exporter-logs-otlp-proto` peers, including for
  trace-only consumers.

## 0.4.0 - 2026-08-15

### Added

- **`@ratel-ai/cloud-sdk/runtime` — one-line runtime facts delivery.** `attach(runtime)` subscribes a
  Ratel SDK runtime (`@ratel-ai/sdk` >= 0.10.0, declared as an optional peer) to fail-open Cloud
  delivery: batched envelope-v2 runtime events to `POST /api/v1/events` and canonically hashed,
  debounced catalog snapshots to `PUT /api/v1/catalog/snapshot`, with a `flush()`/`close()`
  lifecycle. Only the frozen remotely publishable v1 event set (ADR-0020, exported as
  `RUNTIME_EVENT_TYPES` with `isRemotelyPublishable`) leaves the process; the `sourceId` is
  normalized once and stamped on both lanes. Delivery never throws into the host: against an SDK
  without runtime events, `attach()` warns once and returns a no-op handle; `RATEL_CLOUD_EVENTS=off`
  disables event delivery (catalog snapshots remain enabled). `close()` guarantees no request starts
  after it resolves, and explicitly awaited `flush()`/`close()` calls keep the event loop alive
  across retry delays while background drains stay unreferenced. `DeliveryStatus` exposes
  accepted/rejected/dropped introspection for both lanes. Building blocks are exported for direct
  use: `RuntimeEventsPublisher`, `CatalogSnapshotsPublisher`, `hashCatalogSnapshot`, and the batch
  caps (`RUNTIME_EVENT_BATCH_MAX_BYTES`, `RUNTIME_EVENT_BATCH_MAX_EVENTS`, `RUNTIME_EVENT_MAX_BYTES`).
- **Deferred delivery instead of silent loss during rollout.** While Cloud's runtime-events ingest
  flag is off, event batches acknowledged with the explicit `deferred: true` field are requeued
  within queue bounds and retried on a slow cadence (30s floor, doubling to a 5 min cap, resetting
  on success); catalog snapshots deferred with `202 {synced:false}` retry on the same discipline,
  and deterministic 4xx rejections surface once instead of retrying forever. Against an older Cloud
  without the `deferred` field, event delivery keeps the previous best-effort behavior.

## 0.3.0 - 2026-07-30

### Added

- `aiSdkSignalFilter` (`@ratel-ai/cloud-sdk/otel`) — the Vercel AI SDK clause of the default span
  filter, exported so hosts can compose or test it on its own.

### Changed

- The default span filter (`ratelSignalFilter`) now also forwards the AI SDK's legacy `ai.*`
  telemetry that Ratel Cloud normalizes into `gen_ai.*` on ingest: the `ai.toolCall` span and the
  chat model spans (an `ai.`-prefixed name containing `doGenerate` or `doStream`, e.g.
  `ai.streamText.doStream`). Previously they carried no `gen_ai.*` attribute and never left the
  process. Strictly additive — every span forwarded before is still forwarded. Two things stay
  dropped, for two distinct reasons: the `ai.streamText` / `ai.generateText` **wrappers**, which
  duplicate the prompt of the model span beneath them (roughly doubling egress) and would be
  ingested as a second anchor for the same call; and the **embedding / rerank** spans
  (`ai.embed.doEmbed`, `ai.embedMany.doEmbed`, `ai.rerank.doRerank`), which Cloud would stamp as
  chat completions.

### Fixed

- The `@opentelemetry/exporter-trace-otlp-proto` peer range is `>=0.220.0 <1.0.0` instead of
  `^0.220.0`. On a 0.x version a caret pins the minor, so a host already on 0.221.0 (which
  `@opentelemetry/sdk-trace-node@2.10.0` pulls in transitively) could not satisfy the peer without
  an override. The processor only uses the stable `OTLPTraceExporter({ url, headers })`
  constructor, unchanged across the 0.2xx line.

## 0.2.0

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
- `intents.analyze` accepts `noCache: true` (testing/debugging): skips the server's stored-run
  cache and replaces the stored run with a fresh extraction.

### Changed

- `intents.analyze` never degrades server-side anymore. Previously, if the cloud's extractor was
  unconfigured or failed, the server silently echoed the conversation's user messages back as
  intents — and cached that result. Now those conditions throw a `CloudSdkError` with code
  `"unavailable"` (reason `"extractor_not_configured"` / `"extractor_unavailable"`); retry the
  call. Runs cached by the old fallback can be healed with a single `noCache: true` analyze.

## 0.1.0

Initial release.

- `RatelCloudSdk` — Bearer-authed client over the Ratel Cloud v1 API.
- `skills.*` — managed-catalog CRUD, publish/archive lifecycle, optional version CAS, bulk
  `import`.
- `intents.analyze` — conversation → intents → coverage → gap suggestions (drafted inline).
- `suggestions.*` — list/generate/approve/reject.
- `@ratel-ai/cloud-sdk/testing` — `MockCloud`, an in-process mock of the v1 surface.
- `@ratel-ai/cloud-sdk/otel` — the Ratel Cloud telemetry destination (RS-49). `RatelSpanProcessor`
  composes onto a provider the host owns; Ratel ships no bootstrap and registers nothing globally.
  - Default signal filter (`ratel.*` span names, `gen_ai.*` / `ratel.*` attribute keys) with a
    per-instance `spanFilter` override. Note any `ratel.*` attribute key opts a span in.
  - The route derives from the client's own `baseUrl` — traces default to
    `https://cloud.ratel.sh/api/v1/traces`, with `RATEL_OTLP_ENDPOINT` / `endpoint` to point at
    any OTLP backend. Export is OTLP `http/protobuf`.
  - Auth precedence: `apiKey` → a caller-supplied `Authorization` header → `RATEL_API_KEY`.
  - `enabled: false` is a strict no-op — no config resolution, no environment read, no exporter.
  - `ratel.experiment.*` baggage is copied onto spans as attributes at `onStart` (the RS-33 arm
    stamping seam); the processor reads the host's context and never installs a `ContextManager`.
  - The OpenTelemetry packages are **optional peer dependencies** reached only through the
    `/otel` subpath: the package root remains dependency-free, and a layout test enforces it.
  - Traces are the whole surface: Cloud reads captured content from the
    `gen_ai.client.inference.operation.details` span event on the same signal, so forwarding spans
    forwards captured messages. No Logs processor ships, because Cloud consumes no OTLP Logs signal.
- Vendored `protocol/v1` conformance vectors, reproduced byte-for-byte in tests.
