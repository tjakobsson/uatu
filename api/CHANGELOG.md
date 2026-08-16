# API changelog

Entries are ordered newest first. Every entry has Hub and workspace revisions, a compatibility classification, and migration guidance. Use `None` when no migration is required.

## Hub 1 / Workspace 1 - Unreleased

Compatibility: initial

### Changes

- Captured the existing Hub, proxied workspace, SSE, NDJSON, terminal REST, and terminal WebSocket behavior as the initial experimental contract.
- Added authenticated workspace chat status, model inventory, conversation inventory, snapshot, mutation, and replayable SSE operations. Prompt requests can select an available model and acceptance can include a provider-updated conversation title. This is additive; existing clients require no migration.
- Added authenticated slash-command discovery. Recognized leading slash prompts execute OpenCode commands, skills, or compaction while unknown and malformed slash text remains an ordinary prompt. This is additive; the prompt request and response contract is unchanged.

### Migration

None. This is the first published contract and makes no compatibility claim for earlier undocumented builds.
