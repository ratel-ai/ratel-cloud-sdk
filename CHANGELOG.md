# Changelog

## 0.1.0 (unreleased)

Initial release.

- `RatelCloudSdk` — Bearer-authed client over the Ratel Cloud v1 API.
- `catalog.pull` — read-only `protocol/v1` pull with ETag revalidation and `scope`.
- `skills.*` — managed-catalog CRUD, publish/archive lifecycle, version CAS, bulk `import`
  (S2 server contract).
- `intents.analyze` — conversation → intents → coverage → gap suggestions (S3 server contract).
- `suggestions.*` — list/generate/approve/reject (live server surface).
- `@ratel-ai/cloud-sdk/node` — `readSkillsFromDir` SKILL.md folder reader.
- `@ratel-ai/cloud-sdk/testing` — `MockCloud`, an in-process mock of the v1 surface.
- Vendored `protocol/v1` conformance vectors, reproduced byte-for-byte in tests.
