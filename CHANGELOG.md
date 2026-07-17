# Changelog

## 0.1.0 (unreleased)

Initial release.

- `RatelCloudSdk` — Bearer-authed client over the Ratel Cloud v1 API.
- `skills.*` — managed-catalog CRUD, publish/archive lifecycle, optional version CAS, bulk
  `import`.
- `intents.analyze` — conversation → intents → coverage → gap suggestions.
- `suggestions.*` — list/generate/approve/reject.
- `@ratel-ai/cloud-sdk/testing` — `MockCloud`, an in-process mock of the v1 surface.
- Vendored `protocol/v1` conformance vectors, reproduced byte-for-byte in tests.
