# Tasks — add-claude-code-agent

## 1. Spike: Claude Agent SDK under Bun and in the binary

- [x] 1.1 Add `@anthropic-ai/claude-agent-sdk`, run a minimal `query()`
      prompt-and-stream round trip under `bun run` against a real local
      `claude` — including a rewind round trip, since the
      reversible-history capability depends on it — and record the
      observed message shapes as fixtures; verify the round trip
      completes and fixtures are committed
- [x] 1.2 Prove the SDK survives `bun run build`: compile `dist/uatu`
      with the SDK imported and verify `bun run smoke` plus a manual
      `query()` invocation from the compiled binary; if it fails,
      stop and decide the D1 fallback with the user before continuing
- [x] 1.3 Run `bun run check:licenses` and verify the new dependency
      passes the license audit

## 2. Seam refactor (OpenCode behavior unchanged)

- [x] 2.1 Move `normalization.ts` (+ tests) into `src/chat/opencode/`
      and change the provider interface so `listMessages` returns
      normalized `ConversationItem` pages and `events()` yields
      normalized updates tagged with conversation id; adapter stops
      importing OpenCode normalization; verify `bun test src/chat`
      passes with the adapter tests rewritten against normalized inputs
- [x] 2.2 Rename shared seam types to neutral names (`OpenCodeProvider`
      → `ChatProvider`, adapter/service names likewise) and move
      OpenCode runtime + sdk-v2 provider under `src/chat/opencode/`;
      verify `bun run typecheck` and the full unit suite pass
- [x] 2.3 Extract the runtime seam (`status`/`retry`/`dispose`) from
      `LazyOpenCodeChatService` so the service takes an injected
      agent stack; generalize `executable.ts` discovery to any binary
      name; verify existing opencode-service and service tests pass
      unchanged in behavior
- [x] 2.4 Run `bun test` and a manual `bun run dev` OpenCode
      conversation to verify the refactor is behavior-neutral before
      any multi-agent work builds on it

## 3. Agent registry and the breaking API revision

- [ ] 3.1 Implement the agent registry and routed multi-agent chat
      service (qualified conversation ids, per-agent status fan-out,
      merged inventory, wrong-agent requests rejected); verify with
      unit tests using two stub agents covering routing, id collision,
      and one-agent-down inventory
- [ ] 3.2 Revise the chat wire contract: `agent` field on summaries,
      snapshots, and inventory announcements; per-agent availability in
      status; agent parameter on conversation creation; agent-scoped
      catalog reads; update `api/openapi.yaml` and verify
      `bun run api:validate` and `bun run test:api` pass
- [ ] 3.3 Make OpenCode startup lazy per-conversation-need (opening
      Chat or another agent's conversation must not spawn `opencode`);
      verify with a service test asserting no spawn until an OpenCode
      conversation is created or listed
- [ ] 3.4 Client: per-conversation agent identity in state, header
      identity row follows the selected conversation, agent choice with
      availability at conversation creation (default = last used, then
      server default), merged chooser with agent attribution; verify
      with `src/chat/ui` unit tests and a two-stub-agent e2e covering
      creation choice, chooser attribution, and header follow
- [ ] 3.5 Scripted-agent dev harness: wire a scripted agent double into
      a dev serve mode so the agent-choice, chooser, and every later
      Claude surface can be exercised in the browser without a real
      agent; verify by demoing the agent-choice and chooser UX live for
      review before starting group 4

## 4. Claude Code agent

- [ ] 4.1 Claude runtime: executable discovery + bounded version/auth
      probe producing `ChatAvailability` with reused
      `ChatStartupDiagnostics`; retry support; verify with unit tests
      for not-installed, probe-timeout, and ready paths
- [ ] 4.2 Transcript reader in `src/chat/claude/`: cwd encoding,
      per-line shape validation with skip-and-count, session
      enumeration and history paging from
      `~/.claude/projects/<encoded-cwd>`; verify with fixture-based
      tests including a foreign-directory and a corrupt-line fixture
- [ ] 4.3 Claude provider core loop: per-conversation `query()`
      sessions with resume, prompt, streamed normalization into shared
      timeline items (text, reasoning, tools, status, usage),
      interrupt, session supervision and dispose-kills-process; verify
      with unit tests over recorded SDK message fixtures and a
      leak test asserting no process outlives dispose
- [ ] 4.4 Permissions and questions: `canUseTool` → pending
      `PermissionRequest` with once/always/reject mapping and
      session-end resolution; `AskUserQuestion` → `QuestionRequest`
      preserving options/multi-select and answering in tool shape;
      verify with unit tests for approve, always-suppresses-repeat,
      reject, dead-session resolution, and a multi-question form
- [ ] 4.5 Modes, models, effort, commands: permission modes as
      `ChatMode`s with `bypassPermissions` behind a serve-level
      operator opt-in; per-model manifest with effort levels as
      variants and context windows; slash-command listing; truthful
      capability declaration; verify with unit tests including
      bypass-absent-by-default and effort-invalid-for-model
- [ ] 4.6 Attachments: provider sends stored image bytes as image
      blocks with the prompt, `imageInput` reported from the model
      manifest, replay maps recoverable references and renders labeled
      placeholders otherwise; verify with unit tests including an
      unrecoverable-reference fixture
- [ ] 4.7 Plan approvals: classify `ExitPlanMode` as a plan approval,
      add the additive approval-choice extension to `PermissionRequest`
      (wire + card), map implement / implement-and-restore intents to
      mode restoration and rejection to continued planning; verify with
      unit tests for both intents and rejection, update
      `api/openapi.yaml` + `bun run test:api` for the extension, and
      demo the plan card on the scripted harness
- [ ] 4.8 Task progress: add the `task_progress` timeline item kind
      (types, wire contract, shared renderer with in-place upsert),
      emit it from the Claude provider live and on replay; verify with
      renderer unit tests (single presentation across many updates), a
      replay fixture showing final state, and a scripted-harness demo
      of the surface updating live
- [ ] 4.9 Reversible history: implement provider-level undo, redo,
      revert, and restore over the SDK's rewind (conversation boundary
      + file restoration, draft text returned, failures reported
      without claiming change); declare the capability; verify with
      unit tests over rewind fixtures including a failing rewind
- [ ] 4.10 Subagents: sidechain tracker folding live SDK/hook
      observations and transcript replay into per-run child
      transcripts served read-only under synthetic child conversation
      ids wired to `childConversationId`, with model/usage attribution
      on the launching row and children excluded from inventory; verify
      with fixture tests for live tracking, replay reconstruction, and
      inventory exclusion
- [ ] 4.11 Register the Claude agent in `cli.ts` server assembly behind
      the registry; verify a manual `bun run dev` session can create,
      prompt, interrupt, and resume a Claude conversation end-to-end

## 5. Integration, docs, release

- [ ] 5.1 E2E: Claude provider double wired through
      `tests/e2e/server.ts`; scenarios for agent choice at creation,
      cross-agent chooser, permission card round trip, question form,
      attachment round trip, plan approval intents, task-progress
      in-place updates, undo round trip, subagent drill-down and
      return, and OpenCode-unaffected-by-Claude-outage; verify
      `bun test:e2e` passes
- [ ] 5.2 Opt-in real-binary integration test mirroring
      `real-opencode.integration.test.ts` for the Claude provider
      (guarded by env var); verify it passes locally with a real
      `claude` install
- [ ] 5.3 Docs: reorganize `docs/OPENCODE-CHAT.md` into an
      agent-neutral chat doc with per-agent prerequisite sections;
      update `ARCHITECTURE.md` and `CLAUDE.md` folder maps for
      `src/chat/opencode/` and `src/chat/claude/`; verify doc links
      and folder references match the tree
- [ ] 5.4 Full gate: `bun run typecheck`, `bun test`,
      `bun run api:validate`, `bun test:e2e`, `bun run build` +
      `bun run smoke`, `bun run check:licenses` all pass; walk the
      running UI end-to-end — agent choice, a real Claude
      conversation, permission and question cards, plan approval,
      task progress, an attachment, undo, and a subagent drill-down —
      before calling the change done
