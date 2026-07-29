# Changelog

## 0.1.0 (unreleased)

Initial release.

- `RatelCloudSdk` — Bearer-authed client over the Ratel Cloud v1 API.
- `skills.*` — managed-catalog CRUD, publish/archive lifecycle, optional version CAS, bulk
  `import`.
- `intents.analyze` — conversation → intents → coverage → gap suggestions.
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
