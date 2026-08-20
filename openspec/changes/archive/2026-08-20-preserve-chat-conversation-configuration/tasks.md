## 1. Conversation Configuration Domain

- [x] 1.1 Add the normalized `ConversationConfiguration` type, strict validators, snapshot field, prompt-acceptance field, configuration event, and `conversation-rename` capability with valid/invalid fixtures.
- [x] 1.2 Extend the provider abstraction to read one session's effective configuration, and normalize current native plus compatibility OpenCode session/message shapes without inventing absent fields.
- [x] 1.3 Add provider tests proving model, mode, and variant recovery from persisted records, including partial/unknown state and a fresh provider instance that models workspace restart.
- [x] 1.4 Make snapshots recover configuration through the provider seam and keep adapter configuration caches as non-authoritative accelerators that fall back after eviction/restart.
- [x] 1.5 On accepted prompts and provider-reported session changes, update the effective configuration and publish a replayable, idempotent configuration event; test two subscribers and stale/replayed cursors.

## 2. Conversation Rename Backend

- [x] 2.1 Add an adapter rename operation using the existing receipt store, provider rename support, workspace revalidation, the 200-byte trimmed-title limit, and a replayable conversation-update event.
- [x] 2.2 Expose rename through the lazy Chat service and the existing conversation route as an authenticated, same-origin mutation with strict body validation and normalized unsupported/not-found/conflict errors.
- [x] 2.3 Cover successful, retried, invalid, foreign-workspace, unsupported, running-conversation, and first-prompt-title interactions in adapter and route tests.

## 3. Client State And Controls

- [x] 3.1 Parse snapshot/acceptance configuration and conversation configuration/update events in the client and projection, preserving event replay and resync behavior.
- [x] 3.2 Replace persisted per-conversation model/mode/variant authority with per-open-client staged selections; ignore and prune legacy maps while leaving drafts, anchors, expansion, and geometry persistence unchanged.
- [x] 3.3 Render effective offered selections, truthful unavailable/current selections, and non-claiming agent-default/unknown options; omit unknown fields from prompts and never preselect the first model for an existing conversation.
- [x] 3.4 Keep explicit staged choices local across conversation events, clear them only after accepted submission or discard, and update clean controls when another client publishes configuration.
- [x] 3.5 Add a capability-gated rename affordance that validates, submits, reports failures without losing the title, and updates the chooser/header from mutation responses and stream events.
- [x] 3.6 Rename the creation action to `New conversation` in visible and accessible copy, with no `New agent` terminology.

## 4. Public Contract

- [x] 4.1 Add the configuration schemas, widened snapshot/prompt result, configuration and conversation-update stream variants, rename operation, title limits, and rename capability to the OpenAPI and streaming contracts.
- [x] 4.2 Bump `workspaceApiRevision`, update operation metadata/route coverage/examples, and document strict-consumer migration in `api/CHANGELOG.md`.
- [x] 4.3 Run the API contract validation and generated-contract tests, correcting every closed-schema and route-table mismatch.

## 5. End-To-End Verification

- [x] 5.1 Add browser coverage where one client accepts model/mode/variant changes and a second client restores and live-updates them without applying its own defaults.
- [x] 5.2 Add browser coverage for unknown configuration, a staged local override during a remote update, restart recovery, rename propagation/persistence, unsupported rename, and `New conversation` wording.
- [x] 5.3 Extend the real-OpenCode integration coverage to verify persisted configuration fields recover through the supported SDK record shapes without depending on adapter memory.
- [x] 5.4 Run TypeScript checks, the focused Chat/server/API suites, the full `bun test` suite, relevant serial Playwright tests, and `openspec validate preserve-chat-conversation-configuration --strict`.
