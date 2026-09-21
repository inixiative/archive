# Archive extraction provenance

The initial portable schema, transcript import, SQLite store and core tests were extracted from `kingdom-workspace/foundry/packages/archives` at Foundry checkpoint `73e501dae712005f8e03822d76726e403a9e2709`. Streaming file import and preview came from `packages/foundry/src/archives`. Only these archive-specific source files were copied; no session histories, credentials or internal QA artifacts were included.

The standalone server, destination configuration and CLI are developed here. The owner selected MIT for Archive on 2026-09-20. Archive is published independently under MIT. Deployment credentials and machine-specific runbooks are excluded from the public repository.
