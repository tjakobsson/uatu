## Context

See proposal.md — Why. What is in place, and what 2.x actually changed (all verified against a 2.0.13 binary run in a sandboxed home; `/tmp/oc-v2-bin` on the author's machine):

- `chat/opencode/opencode-service.ts` spawns `opencode serve --hostname 127.0.0.1 --port <n>` with `OPENCODE_SERVER_PASSWORD`, then polls `GET /global/health` with basic auth until `{ healthy: true, version }`. Any HTTP answer flips the probe from the bind budget to the short health budget. The connection (`endpoint`, `password`) is handed to `openCodeAgentRuntime` in `chat/service.ts`, which builds the provider with `createSdkV2Provider` — the only file that imports `@opencode-ai/sdk` (`/v2` subpath, pinned 1.18.30).
- 2.x keeps `serve --hostname --port`, reads `OPENCODE_PASSWORD` and falls back to `OPENCODE_SERVER_PASSWORD` (`packages/cli/src/env.ts`), and serves basic auth with username `opencode`. Readiness is `GET /api/info` → `{ version, pid, urls, paths }` (401 without auth). `/global/health`, `/health`, `/` and every other unknown path answer `200 text/html` (the bundled web UI). `--version` prints `opencode v2.0.13`; 1.x prints `1.18.31`.
- 2.x's API is `@opencode/client` 2.0.13 (deps `@opencode/schema`, `@opencode/protocol`; MIT). `OpenCode.make({ baseUrl, headers, fetch })`. All routes live under `/api/…`; the event stream is `GET /api/event` (SSE, `: heartbeat` keepalives, first frame `server.connected`), consumed through `client.event.subscribe({ signal }) → AsyncIterable<V2Event>`. Method map from what uatu calls today: `session.create/get/list/update/prompt/command/interrupt/compact`, `session.revert.stage/commit/clear`, `session.message.list/get` (cursor-paginated `SessionMessagesResponse`), `session.form.list/get/reply/cancel`, `permission.request.list/get/reply`, `agent.list`, `command.list`, `model.list/default`, `provider.list`, `location.get`, `server.info`. Directory scoping is `location: { directory }` on inputs; `SessionInfo.location` and every event's optional `location: { directory }` carry it back.
- 2.x's session event vocabulary is 1.18's `session.next.*` generation with the `next.` segment dropped: `session.text.{started,delta,ended}`, `session.reasoning.*`, `session.tool.{input.started,input.delta,input.ended,called,progress,success,failed}`, `session.step.{started,streamed,ended,failed}`, `session.shell.*`, `session.revert.{staged,committed,cleared}`, `session.compaction.*`, `session.synthetic`. `permission.asked/replied`, `session.created/deleted/idle/status` are verbatim. New in 2.x: `session.execution.{started,succeeded,failed,interrupted}`, `session.usage.updated` (cumulative `cost` + `tokens`), `session.message.content.updated`, `session.{agent,model}.selected`, `session.retry.scheduled`, `form.{created,replied,cancelled}`. Gone: every `message.*` event (`message.updated`, `message.part.updated/delta/removed`) and `question.*`.
- `chat/opencode/normalization.ts` already handles the `session.next.*` generation beside the `message.*` one (the spec's "either naming generation"). Its 1.x-only work is the cumulative/incremental dedup across `message.part.*` and the `question.*` family.
- The workspace status object is a closed API shape (`ChatAvailability { state: "ready"; version }`, `ChatDiagnostics`); adding a field means a workspace API revision bump.

## Goals / Non-Goals

**Goals:**
- One spawned server, one decided generation, one provider — decided from the readiness answer, never from `--version` text or the binary's path.
- Reuse the `session.next.*` normalization for 2.x instead of writing a parallel one; write new code only for what 2.x genuinely changed.
- Keep the wire shapes: no workspace or hub API revision.
- Make both generations testable on one machine without either being on `PATH`.

**Non-Goals:**
- Any product-level executable override (a `UATU_OPENCODE_BIN`): discovery stays PATH-based; the side-by-side story is a wrapper directory the developer prepends.
- 2.x's `session.inbox`, worktrees, ptys, skills, `opencode service` (shared background server), or `--stdio`.
- Changing the client: it sees the same conversation events, capabilities, and routes.

## Decisions

**Readiness probes both contracts every cycle; the first well-formed body decides.**
`waitUntilReady` issues `GET /api/info` and `GET /global/health` (both with the basic-auth header; the order is info first because a 2.x server's `/global/health` costs a full HTML page). A response counts as "answered" for the phase split whatever its body — a 2.x HTML 200 on `/global/health` correctly moves the probe onto the short health budget, and the info probe in the same cycle makes it ready. Acceptance is strict: `/global/health` needs `healthy === true`, `/api/info` needs a string `version`; anything else is `unhealthy-body`. `ProbeProgress.lastOutcome` becomes per-path (`{ health, info }`) so `describeProbe` can say both, e.g. `health: 200 with a non-health body; info: 401`. The result carries `{ generation: 1 | 2, version }` and `OpenCodeConnection` gains `generation`. The version is normalized (`/^opencode\s+v?/` stripped from the info answer; 1.x already sends bare semver) so the status wire shape stays `version: string` and the generation is readable from its major.
Alternatives: (a) run `opencode --version` first and branch — rejected, the spec forbids text-format dependence for readiness and the `probeVersion` helper is explicitly a failure-path aid; (b) probe `/api/info` only after `/global/health` fails to parse — needless extra cycle on every 2.x start; (c) add `generation` to the status object — rejected, it is a closed shape and the version already says it.

**Provider selection lives where the connection is handed over.**
`openCodeAgentRuntime` maps `connection.generation` to a factory: `{ 1: createOpenCodeV1Provider, 2: createOpenCodeV2Provider }`; the `createProvider` test seam becomes that map (default per generation, override per generation). The service does not learn anything about providers, as today.

**Folder layout: `chat/opencode/v1/` and `chat/opencode/v2/`, shared code stays at the root.**
`sdk-v2-provider.ts` → `v1/provider.ts`, `normalization.ts` → `v1/normalization.ts` (with tests), because "sdk-v2" will read as the 2.x stack the moment one exists. `opencode-service.ts`, `notification-lifecycle.ts`, and the shared normalization core (below) stay at `chat/opencode/`. `CLAUDE.md`'s folder map and `ARCHITECTURE.md` get the two-generation picture. Git `mv` so history follows.

**One normalization core keyed by canonical event names; each generation supplies a mapper.**
The `session.next.*` handlers in `normalization.ts` become the core, keyed by the canonical (2.x) name. The 1.x mapper renames `session.next.X` → `session.X`, keeps its `message.*` cumulative/incremental dedup and `question.*` → structured-question handling, and is otherwise the code that exists today. The 2.x mapper passes session events through, and adds: `session.execution.*` → turn started/succeeded/failed/interrupted (1.x derived these from `session.status`/`session.idle`/`session.error`); `session.usage.updated` → the context/usage update (cumulative per session); `form.*` → structured question raised/answered/rejected; `session.message.content.updated` → a restatement of an assistant message's content that must not duplicate streamed text (same dedup principle as 1.x cumulative parts, keyed by message id + ordinal); `session.{agent,model}.selected` → configuration update (`replaceModel`). Events with a `location.directory` that is not the workspace's are dropped before mapping. Unrecognized types fall into the existing per-type discard counter.
Alternative: a wholly separate `v2/normalization.ts` — rejected: 34 of the session event names are shared verbatim after the `next.` rename, and two copies of the tool/step/text state machines would drift.

**2.x forms are structured questions, one question per field.**
`FormCreated.data.form.fields` → `StructuredQuestion[]`: a `string` field with `options` is single-select (its `custom` flag maps to uatu's custom-answer choice, default on when omitted — the existing "Structured questions follow OpenCode custom-answer semantics" rule), `multiselect` is multi-select with `minItems/maxItems`, a `string` without options is free text, `number/integer/boolean` are free text with the field's constraints in the prompt and validated before reply (`FormInvalidAnswerError` is surfaced as the prompt failure it is). `replyQuestion(answers)` folds the ordered answers back into `{ [field.key]: value }` for `session.form.reply`; `rejectQuestion` is `session.form.cancel`. `listQuestions` reads `form.list` for the workspace, which answers pending forms only: an answered or cancelled form leaves the list, and the list record carries no `state` (only `form.get` does) — verified against 2.0.13. `when` (conditional fields) and `external` fields are out of scope: a form containing them is presented without those fields, and the form's `title` is the question intro.

**2.x permissions reuse the 1.x path.**
`permission.asked` is verbatim; `PermissionRequest.save` is the future-approval pattern list (1.x calls it `patterns`/`always`), `resources` is what the request names, `source.messageID`/`source.id` is the tool attribution the subagent-origin rule needs. Reply is `permission.request.reply` with the once/always/reject vocabulary `PermissionReplyInput` defines; `listPermissions` is `permission.request.list({ location })`.

**History comes from `session.message.list`; per-message accounting from the assistant message record.**
`listMessages` pages `session.message.list({ sessionID, order: "desc", limit, cursor })` and maps `SessionMessageInfo` variants: `user` → user item (with `files` as attachments), `assistant` → assistant item with its content array (text, reasoning, tool states `streaming/running/completed/error`, retry), `compaction` → compaction marker, `shell` → shell item, `agent-switched`/`model-switched`/`location-switched`/`synthetic`/`system`/`skill` → configuration or silent. `ProviderHistoryPage.accounting` is built from the assistant record's tokens/cost, as 1.x builds it from `message.updated`; the cost receipt (`conversation-totals`) is unchanged. `history-reuse.ts` versioning is generation-agnostic and untouched.

**Directory scoping on 2.x.**
`location: { directory }` on `session.list`, `session.create`, `model.list`, `agent.list`, `permission.request.list`, `session.form.list`; `SessionInfo.location.directory` must equal the workspace for a session to be listed or opened (the same foreign-session refusal 1.x applies). Events are filtered on `event.location.directory` where present; events without a location (`server.connected`, catalogs) pass.

**Attachments ride as `file://` URIs.**
`session.prompt({ files: [{ uri, name }] })` gets `pathToFileURL(attachment.absolutePath)` — the same URL 1.x sends as a file part today; the server is local and reads it. Mime is the server's to infer.

**Both password variables are set.**
`buildOpenCodeEnvironment` sets `OPENCODE_PASSWORD` and `OPENCODE_SERVER_PASSWORD` to the same secret. 2.x reads the first, 1.x the second; the diagnostics redaction list gains the new name.

**Capabilities are declared per generation and only when backed.**
The 2.x `describe()` starts from the 1.x list and drops anything the integration test cannot demonstrate against a real 2.x server. Expected to hold: `modes` (`agent.list`), `models` (`model.list` with `variants` and `capabilities.input.image`), `commands`, `questions` (forms), `permissions`, `subagents` (`parentID`), `variants`, `context` (`session.usage.updated`), `conversation-rename` (`session.update` title), `attachments`, `reversible-history` (`revert.stage/commit/clear`). Usage reporting (`usageReport`/`readUsage`) stays undeclared on 2.x until its equivalent is found.

**Integration test: same assertions, two binaries, chosen by environment.**
`real-opencode.integration.test.ts` keeps `UATU_REAL_OPENCODE=1` as the gate and reads `UATU_REAL_OPENCODE_V1` / `UATU_REAL_OPENCODE_V2` (absolute paths to binaries). For each that is set it builds a temp `bin/` with a symlink named `opencode`, prepends it to the child's `PATH`, and runs the shared assertions plus the generation assertion (`version` major). The 2.x run sets `XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME` to a temp root so it never opens the developer's 1.x database (2.x with default paths opens `~/.local/share/opencode/opencode.db` and applies nine migrations 1.x does not have). Neither variable set → the 1.x path runs against `PATH` as today, so CI is unchanged. The side-by-side install (download the zip the `anomalyco/tap/opencode-v2` formula points at, a wrapper script that exports the `XDG_*` roots, `opencode auth login` inside it) is documented in `ARCHITECTURE.md`.

**Dependency pinning follows the 1.x posture.**
`@opencode/client` is pinned exactly (2.0.13 at proposal time), like `@opencode-ai/sdk`. The pinned client speaks a contract; a user's newer binary is expected to keep it (2.x versions its wire as `/api` with `durable.version`), and drift surfaces as counted unrecognized events, not as a startup failure. `bun run check:licenses` covers the three new MIT packages.

## Risks / Trade-offs

- [2.x is moving weekly; a route or event uatu depends on changes] → Pinned client, per-type discard counters, and the integration test against a named binary. Bumping the pin is a `chore(deps)`; a contract break shows up in that test, not in production first.
- [Per-message tokens and cost may not be on the assistant record in 2.x] → `session.usage.updated` is cumulative per session; if per-message figures are absent, `context` is still declared (session totals are enough for the indicator) and the receipt's per-message accounting falls back to session deltas between turns. Decided at the integration test, without changing the seam.
- [`/global/health` on 2.x is a full HTML page every probe cycle] → Info is probed first and decides on the first cycle; the health probe runs at most once on a 2.x server.
- [A 1.x server answers `/api/info` with 404 before `/global/health` is healthy] → 404 is "answered, http-status"; the health probe in the same cycle decides. No change to 1.x timing.
- [Two generations share the developer's OpenCode database] → Outside uatu; the integration test isolates 2.x with `XDG_*` and the developer note says why.
- [`file://` attachment URIs may be refused by 2.x's prompt] → Verified in the 2.x integration run (the attachments assertion); fallback is a `data:` URI, which the client type also admits.
- [Renaming `sdk-v2-provider.ts` churns open branches] → `git mv`; the seam and test names are unchanged, so conflicts are path-only.

## Migration Plan

No user-facing migration: a workspace with 1.x behaves as before; one with 2.x starts working. No data, config, or wire changes. Rollback is reverting the change.

## Open Questions

Both settled during implementation against a real 2.0.13 stream (fixtures in `tests/fixtures/opencode-v2/real-2.0.13.json`):

- Per-message tokens and cost ride `session.step.ended` (`assistantMessageID`, `tokens`, `cost`) live, and the assistant record (`tokens`, `cost`, `model`, `agent`) on history. `session.usage.updated` is the session's running total and is ignored as a carrier. One step is one assistant message, so the `usage:<messageId>` carrier is minted once per message, as on 1.x.
- `client.permission.reply({ sessionID, requestID, decision: "once" | "always" | "reject", message? })`; pending requests are `client.permission.request.list({ location })`. Client-minted message ids must start with `msg_`, which `stableProviderId("msg", requestId)` already satisfies.
- `session.compact` takes a client `id` and echoes it on the record and in `session.inbox.enqueued`; `session.command` takes none and answers `204`, minting the command's user inbox item itself (with the expanded template as its text). The 2.x `command()` learns that id from the stream inside its admission window and falls back to the local id without one; a retry after a lost response can therefore run a command twice on 2.x, which the API gives no key to prevent.
