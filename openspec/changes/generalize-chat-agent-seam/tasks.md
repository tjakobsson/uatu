# Tasks — generalize-chat-agent-seam

This change is the bottom pull request of a GitHub stack,
`refactor(chat)!: generalize the chat agent seam for more agents`. The `!`
marks the Workspace API revision bump in task 3.2. Its head is
`refactor/generalize-chat-agent-seam` in `tjakobsson/uatu`, and its base is
`main`. The first commit carries this OpenSpec change. Each of groups 1–5
below is one behaviour-preserving commit that passes `bun run test:ci` on its
own. The Antigravity pull request (`add-antigravity-chat`, head
`feat/add-antigravity`) is the top of the stack.

## 0. Planning

- [ ] 0.1 Commit this OpenSpec change on its own and verify that `openspec validate generalize-chat-agent-seam --strict` passes.

## 1. Agent-neutral turn liveness (commit 1)

- [x] 1.1 Add characterization tests for today's liveness and text-seal decisions: OpenCode 1.x and 2.x text end, execution evidence, step failure and completion alias, and Claude Code live and history rows with and without a turn token. Verify that they pass against the current code before anything moves.
- [x] 1.2 Introduce the neutral annotations (text sealed in both forms, execution live yes/no/unknown, turn continues despite terminal status, repeat status) and the neutral sealable turn token with its provisional/authoritative kind in a shared chat module. Move `isVisualTurnLive` there. Verify typecheck.
- [x] 1.3 Make the OpenCode 1.x and 2.x normalizers and the Claude Code normalizer and transcript reader write the neutral annotations. Make `agents.ts` and `adapter.ts` read only those, with token freezing, sealing, preservation and the recovery comparison in one adapter helper. Verify that the 1.1 tests and the existing visuals regressions in `agents.test.ts`, `adapter.test.ts` and `visual-store.test.ts` pass unchanged.
- [x] 1.4 Make `nativeVisualMessageIdentity` take an agent id and the capture-identity helper agent-neutral. Verify with a test that pins `claude:message:<id>`, `claude:text:<apiId>:<n>` and `opencode:message:<id>` byte for byte, and that `<agentId>:message:<id>` is produced for any other agent.
- [x] 1.5 Update the chat sections of `ARCHITECTURE.md` that describe the liveness markers. Verify that no shared module outside `src/chat/claude/` and `src/chat/opencode/` imports a Claude or OpenCode liveness symbol (`rg` check), and that `bun run test:ci` passes.

## 2. Generic PATH runtime and agent-neutral lazy service (commit 2)

- [x] 2.1 Extract `PathAgentRuntime` from `src/chat/claude/runtime.ts`, configured by binary name, display name, version parser and messages, and keep `ClaudeRuntime` as its Claude Code configuration. Verify that `src/chat/claude/runtime.test.ts` passes unchanged, including the not-installed, timeout and failed-probe messages byte for byte.
- [x] 2.2 Replace the inline `AgentRuntime` literal in `src/cli.ts` with a shared adapter, and keep `src/hub/agent-account-runtime.ts` working. Verify typecheck and the agent-account tests.
- [x] 2.3 Make `LazyChatService` agent-neutral: it takes the agent's name and runtime, OpenCode's options move to an OpenCode runtime factory, and the restarting and incompatible-version messages name the owning agent. Verify `src/chat/service.test.ts` with OpenCode's wording unchanged, plus a new test that a Claude Code adapter failure names Claude Code.
- [x] 2.4 Move `ManagedProcess` and the bounded capture into a shared chat process module. The capture takes an optional scrubber, and OpenCode's password scrubbing stays in its stack. Verify that `opencode-service.test.ts` passes unchanged, and add tests for SIGTERM, grace and SIGKILL escalation and for capture bounding.
- [x] 2.5 Update the `CLAUDE.md` folder map and `ARCHITECTURE.md` runtime section for the new shared modules. Verify that `bun run test:ci` passes.

## 3. Agent-declared login (commit 3)

- [x] 3.1 Add `login: { command, hubManaged }` to `ChatAgentDescriptor`, with one descriptor constant per agent used by `cli.ts`, the e2e harness and the Hub (`ACCOUNT_AGENTS`, `CLAUDE_LOGIN_COMMAND`, the OpenCode 2.x `LOGIN_COMMAND`). Verify with a search that each login command string appears once in product code.
- [x] 3.2 Update `parseChatAgentDescriptor`, `api/openapi.yaml`, the next free `WORKSPACE_API_REVISION` (38, or 39 if #625 merged first), `api/contract.json`, the OpenAPI `x-uatu-revisions` block, `BUNDLED_WEB_REVISION` 4 → 5, and an `api/CHANGELOG.md` entry with migration guidance. Verify that `bun run api:validate` and `bun run test:api` pass, including the compatibility gate.
- [x] 3.3 Make `login-action.ts` read the descriptor: link to Agent accounts only on a Hub-served page for a Hub-managed agent, and otherwise show the command. Verify with `login-action.test.ts` cases for Hub-managed on a Hub, not Hub-managed on a Hub, and outside a Hub.
- [x] 3.4 Name the agent in `usageReadFailureLabel` and the `ui.ts` default-model fallback: once the runtime has described itself, every chooser surface uses the runtime's declared name; before that, only the model summary fallback (shown in the summary and the inline/touch chip) uses the registered name, and the picker row and the trigger's accessible label keep main's generic "the agent" wording. Verify that `composer-status.test.ts` and `ui.test.ts` show the same text for Claude Code and OpenCode, the runtime's name for a stub agent whose runtime reports a different name, and all three strings before the runtime describes itself.
- [x] 3.5 Verify that the existing login e2e cases in `tests/e2e/` pass unchanged and that `bun run test:ci` passes.

## 4. Shared pending-interactions holder (commit 4)

- [x] 4.1 Extract `PendingInteractions` and the push queue from `src/chat/claude/provider.ts`, with an explicit cancellation trigger (an `AbortSignal` or a subscribe function). Verify with direct unit tests for settle-once, registration before an already-fired trigger, requested/abandoned emission with nothing emitted on answer, abandonment by conversation, listing, and lookup mismatches.
- [x] 4.2 Switch the Claude Code provider to the holder. Verify with `src/chat/claude/provider.test.ts` and that `bun run test:ci` passes. The provider tests changed with it: their fake queries read prompt input as the SDK does (`FakeQuery.consumeInput`), since a revert's replacement or a prompt during the shutdown grace is acknowledged only once taken; the shutdown fixtures set their grace explicitly, one that cannot expire for work finishing inside it and a short one for expiry; and shutdown tests were added for the sweep order, the bounded grace, the parallel close, the drain and the final flush, and for prompts, wakeups, renames and usage reads during shutdown.

## 5. E2E harness routes any agent (commit 5)

- [x] 5.1 Build the harness routers from one list of fakes keyed by agent id, and strip qualifiers and route `agent` by the registered ids. Keep `claude-fixture` registered as `claude`. Verify that the chat e2e files pass unchanged (`bun run test:e2e` for the affected files) and that `bun run test:ci` passes.
- [x] 5.2 Update the harness notes in `ARCHITECTURE.md` if they name the dual router. Verify that the documented harness actions match `tests/e2e/server.ts`.

## 6. Integration

- [ ] 6.1 Run `bun run typecheck`, `bun run test:ci`, `bun run test:api`, `bun run check:licenses`, `bun run build`, `bun run smoke`, and the chat e2e files on the final head. Verify that all pass and record the results in the PR body.
- [ ] 6.2 Manually check one OpenCode and one Claude Code conversation in `bun run dev`: streaming, an inline image reply, a permission card, and the login notice. Verify that they behave as before.

## Workflow follow-up

- Rebase onto upstream PR #625 when it merges, take the next free workspace revision, and rerun group 6.
- Sync the `chat-agents` and `agent-accounts` deltas and archive this change before the PR's final merge, per CONTRIBUTING.md.
- Mark both stacked PRs ready before merging. Merge bottom-up: this PR squash-merges into its own commit, and GitHub then retargets and rebases the Antigravity PR onto `main`.
