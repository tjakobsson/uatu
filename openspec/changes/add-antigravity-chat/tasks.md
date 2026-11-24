# Tasks — add-antigravity-chat

This change is the top pull request of a GitHub stack,
`feat(chat): add Antigravity as a chat agent`. Both branches live in
`tjakobsson/uatu`. Its head is `feat/add-antigravity` and its base is
`refactor/generalize-chat-agent-seam`. After the seam pull request
squash-merges, GitHub retargets and rebases this one onto `main`
automatically. Both pull requests must be marked ready before the stack can
merge.

**Prerequisite:** `generalize-chat-agent-seam` (all five of its commits).

The first commit carries this OpenSpec change. Each of groups 1–6 below is one
commit that passes `bun run test:ci` on its own.

## 0. Planning

- [x] 0.1 Commit this OpenSpec change on its own and verify that `openspec validate add-antigravity-chat --strict` passes.

## 1. Add the ACP package (commit 1)

- [x] 1.1 Get explicit approval to install `@agentclientprotocol/sdk` (2.x, pinned exactly) and its `zod` peer, then install them. Verify that `package.json` and `bun.lock` change only for these two packages.
- [ ] 1.2 Verify that `bun run check:licenses` and `bun run audit` pass with the new packages.
- [x] 1.3 Prove that both packages bundle into the compiled binary with a minimal import of `client`, `ndJsonStream` and `schema/meta.json`. Verify that `bun run build` and `bun run smoke` pass. If they fail, stop and decide the fallback before group 2.

## 2. The `immediate-steering` capability (commit 2)

- [x] 2.1 Add `immediate-steering` to `ChatCapability`. Verify that `parseChatAgent` accepts it and that `bun run api:validate` and `bun run test:api` pass with no workspace revision change. If the compatibility gate disagrees, bump the revision and add a changelog entry in this commit.
- [x] 2.2 Composer: give an `immediate-steering` conversation the same busy deliveries, guidance, accessible names and hold-to-queue gesture as a `steering` one, with commands and attachment drafts still queued. Verify with `composer.test.ts` and `hold-to-queue.test.ts` cases for a stub immediate-steering agent, and that the existing steering and no-steering cases pass unchanged.
- [x] 2.3 Adapter and dock: deliver a steer to the provider at once with no pending, paused or withdrawable entry; return a refused steer's draft and attachments to the composer; keep an unknown admission as an unconfirmed entry without resending; and keep Send now on the dormant-or-idle rule. Verify with `adapter.test.ts` and `ui.test.ts` stub-agent cases for each.
- [x] 2.4 Keep the turn running across a steer: an earlier prompt's end, which the provider does not publish as a status, sends no completion notification, does not drain the held queue, and does not finish workspace activity. Verify with adapter and notification tests, and with a test that a steered accepted message appears in the timeline once.
- [x] 2.5 Add an e2e case with a stub immediate-steering fake: tap Send steers with no Steer entry, Alt/Option+Enter queues, and the message appears once. Verify that it passes in `bun run test:e2e` for that file and that `bun run test:ci` passes.
- [x] 2.6 Document `immediate-steering` in `docs/CHAT.md` ("Sending, steering and queued messages") and in the `CLAUDE.md` chat folder-map note on keyboard submission. Verify that the documented shortcuts match the composer tests.

## 3. Antigravity provider and runtime (commit 3)

- [x] 3.1 Add `src/chat/antigravity/descriptor.ts` (`antigravity`, "Antigravity", login `agy`, not Hub-managed) and the `PathAgentRuntime` configuration for `agy`. Verify with runtime tests for not installed, probe timeout, an unrecognized version, shadowed executables, and ready.
- [ ] 3.2 Add the fake `agy` executable and redacted trial fixtures under `tests/fixtures/antigravity/`, including a second prompt sent mid-turn. Verify with a search that the fixtures contain no emails, account or plan identifiers, or user home paths.
- [ ] 3.3 Implement the ACP connection: one process per live conversation, release after 5 idle minutes, the short-lived listing process, no file-system or terminal client capability, and shutdown through the shared process helpers. Verify with provider tests that a process is started on first need, released after idle, ended at dispose, and isolated when it crashes.
- [ ] 3.4 Implement listing, the unknown-id guard and `session/load` history. Verify with tests that the chooser lists fixture sessions as `antigravity:<id>`, that an unknown id is refused without a prompt, and that replayed history appears without starting a turn.
- [ ] 3.5 Implement normalization (D5) with the seam's neutral liveness facts and a provisional turn token. Verify with normalization tests for streamed text, thoughts, a command with output and exit code, the waiting-for-permission state, a denial, and each stop reason, plus a visuals test that an image in a reply is captured under `antigravity:message:<id>`.
- [ ] 3.6 Implement permissions through the shared pending-interactions holder (allow once, deny, abandon on cancel and on process exit). Verify with provider tests, including cancelling while a permission is pending.
- [ ] 3.7 Implement models with thinking levels (config options and legacy ids), modes, reapplying them after load or resume, slash commands, interrupt, context reports from `usage_update`, and per-turn token usage. Verify with provider tests for each, including that a resumed conversation's prompt runs on its chosen model.
- [ ] 3.8 Implement immediate steering for agy: serialize prompts, send a steer as a further `session/prompt`, publish no status for the superseded prompt's `end_turn`, keep one turn token across the steer, and give live user messages the ids replay derives. Verify with provider tests against the mid-turn fixture: one turn, one user message after reload, and held messages waiting for the carried turn.
- [ ] 3.9 Implement image attachments gated on the advertised prompt capabilities. Verify with tests that attachments are declared and sent as image blocks when advertised, and not declared otherwise.
- [ ] 3.10 Implement the login-missing state from -32000, its recheck on listing, retry and prompt, and "Antigravity login failed" turn failures. Verify with provider and service tests.
- [ ] 3.11 Register Antigravity last in `src/cli.ts`, declaring the capabilities in the `antigravity-chat` spec. Verify with a service test that chat status lists OpenCode, Claude Code and Antigravity in order with OpenCode as default, that the declaration matches the spec, and that `bun run test:ci` passes.

## 4. Price table (commit 4)

- [ ] 4.1 Write `scripts/update-antigravity-prices.ts` with the D11 rules (base rates only) and the family map. Get approval before running it, because it fetches models.dev, then generate `src/chat/antigravity/prices.ts` with its source and snapshot date. Verify that the script's rule tests pass on a stored sample of the models.dev data.
- [ ] 4.2 Price each turn into `TokenUsage.costUsd`. Verify with tests for thinking at the output rate, cache writes unpriced, a family-borrowed price, equal rates across thinking levels, an unpriced model contributing no cost, and the receipt's by-model total matching the chip.

## 5. Transcript enrichment (commit 5)

- [ ] 5.1 Implement the read-only, size-bounded transcript reader and its matching to replayed rows. Verify with fixture tests that permission outcomes, file-read output and per-turn tokens and model are added, that reopened conversations show earlier cost, and that missing, truncated, foreign and unrecognized files fall back to replay-only history without an error.
- [ ] 5.2 Verify with a test that the transcript file is byte-identical after a read, and that `bun run test:ci` passes.

## 6. Registration polish, docs and coverage (commit 6)

- [ ] 6.1 Add the e2e Antigravity fake to `tests/e2e/server.ts` and an e2e case for the picker order, the login notice with `agy` and no Agent accounts link on a Hub-served page, a basic conversation, and a mid-turn steer. Verify that it passes in `bun run test:e2e` for that file.
- [ ] 6.2 Add `extractAntigravity()` to `scripts/agent-coverage.ts` and `src/chat/antigravity/sdk-coverage.ts`. Verify that `bun run coverage:agents` prints an Antigravity section and that `scripts/agent-coverage.test.ts` passes, including a stale-annotation failure.
- [ ] 6.3 Update `docs/CHAT.md`. Cover:
  - Antigravity prerequisites: install `agy`, sign in by running `agy`, and check that `agy --version` works in the server's environment.
  - Google's consumer-plan policy note, with its three links.
  - The agent list and vocabulary, cost provenance and limits, and the untested areas.
  - The Scope section, which no longer says Chat does not implement ACP.

  Verify that every documented command and path matches the code.
- [ ] 6.4 Update `ARCHITECTURE.md`'s agent sections, the `CLAUDE.md` folder map (`chat/antigravity/`), and CONTRIBUTING.md's list of agent SDKs. Verify that the folder map matches `ls src/chat/antigravity`.

## 7. Integration

- [ ] 7.1 Run `bun run typecheck`, `bun run audit`, `bun run test:ci`, `bun run check:licenses`, `bun run build`, `bun run smoke`, and `bun run test:e2e` on the final head. Verify that all pass and record the results in the PR body.
- [ ] 7.2 With approval, try one conversation in `bun run dev` against a locally signed-in `agy`. Check streaming, a permission card, a mid-turn steer, a model change surviving a resume, cancel, and cost. Verify the observations in the PR body. This is a manual check, not a committed test.

## Workflow follow-up

- Rebase onto `refactor/generalize-chat-agent-seam` when it changes. After it squash-merges, GitHub's stack retargets and rebases this PR onto `main`. Confirm that the rebased head still passes group 7.
- Mark both stacked PRs ready before merging. Merge bottom-up; each squash-merges into its own commit.
- Sync the `antigravity-chat`, `chat-agents` and `agent-coverage-report` deltas and archive this change before the final merge, after `generalize-chat-agent-seam` has been archived.
