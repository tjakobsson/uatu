## 1. Shared runtime pieces

- [x] 1.1 Confirm that `OpenCodeService` in `src/chat/opencode/opencode-service.ts` can be constructed by a caller that is not a workspace, supplying its own cwd (`workspacePath`) and environment, with the two-generation readiness probe unchanged. No factoring is needed. Verified by the existing `opencode-service.test.ts` case "joins concurrent starts and uses authenticated no-shell loopback arguments", which asserts the given cwd and environment reach the spawn.

## 2. Account adapters (design D2)

- [x] 2.1 Define the account wire model: agent status, targets (providers or integrations), methods, the field model (`text` or `select`, options, `required`, `placeholder`, `when`), attempts with `completion: device | code | redirect`, and capabilities. Write normalizers from 1.x `prompts` and 2.x `form` into the field model. Verify with unit tests over the probed 1.18.34 and 2.0.13 method payloads (Copilot's conditional enterprise field, GitLab's instance URL, Cloudflare's account id), with unknown prompt types falling back to text.
- [x] 2.2 Implement the OpenCode 1.x adapter on `@opencode-ai/sdk/v2` (`provider.list`, `provider.auth`, `provider.oauth.authorize` and `callback`, `auth.set`, `auth.remove`). Merge `GET /provider` with `GET /provider/auth`, give providers without listed methods the implicit API key method, and classify `completion` from `method` and the URL's `redirect_uri`. Verify with fake-fetch unit tests for key connect, authorize with inputs, ChatGPT browser classified `redirect`, ChatGPT headless and Copilot classified `device`, and logout.
- [x] 2.3 Implement the OpenCode 2.x adapter over `integration.*` and `credential.*`. The first 404 from `credential.*` drops logout and activate for that runtime. `env` and `command` methods are informational. Verify with fake-client unit tests for key connect with form answers, the OAuth connect/status/complete/cancel cycle, and capability loss on 404.
- [x] 2.4 Implement the Claude adapter:
  - Status from `accountInfo()`: logged in with account and plan, missing, an environment API key, or a third-party provider.
  - Feature-detected `claudeAuthenticate`, `claudeOAuthCallback` and `claudeOAuthWaitForCompletion`, using `manualUrl` only and splitting the pasted `code#state`.
  - Logout through `claude auth logout`.

  Verify with fake-query unit tests for each status mapping, both login methods, code splitting, and the fallback that names `claude auth login` when the methods are absent.

## 3. Hub account service (design D1, D3, D4, D5)

- [x] 3.1 Add the Agent accounts service (`src/hub/agent-account-service.ts`, runtimes in `agent-account-runtime.ts`) with one lazily started account runtime per agent:
  - cwd in a Hub state subdirectory, and the Hub environment minus the stripped ambient variables;
  - one startup retry;
  - a 5-minute idle stop, deferred while an attempt is pending;
  - shutdown with the Hub.

  Verify with unit tests on an injected clock and spawner covering start-on-demand, idle stop, no stop while an attempt is pending, and stop on Hub shutdown.
- [x] 3.2 Add the attempt registry and waiters: one attempt per agent and target, replacement cancels the earlier one, and attempts settle to complete, failed, expired or cancelled. The waiter is the 1.x blocking callback, 2.x status polling, or Claude's wait-for-completion. Verify with unit tests for each waiter's settling, replacement, the 10-minute default expiry, and cancel.
- [x] 3.3 Implement redirect delivery: accept only `http:` with a loopback host and the recorded callback's port and path, make one `GET` with `redirect: "manual"` and a 10 s timeout, and discard the body. Verify with unit tests that a non-loopback host, another port, another path, `https:`, and a submission with no attempt pending are all refused with no request made, and that a matching address is requested exactly once.
- [x] 3.4 Add `GET /api/hub/agent-accounts` and the POST mutations to `src/hub/server.ts`. Add `api/operations.yaml` entries, closed schemas in `api/openapi.yaml`, examples, and an `api/CHANGELOG.md` entry. Verify that:
  - `bun run test:api` and `bun run api:validate` pass;
  - a hub test refuses a cross-origin cookie mutation;
  - a hub test asserts that no response body or Hub log line contains a submitted key, code, or pasted address.

## 4. Changed logins reach running workspaces (design D6)

- [x] 4.1 Add the internal child route `POST /api/chat/accounts-changed {agentId, change}` (mutation gate, covered by `api/exclusions.yaml`). Have the Hub call it on every running session after a successful key, login, logout or activate, finishing before the next change for that agent runs. Verify with a hub test whose two fake running sessions both receive the call with the change, a service test that a second mutation waits for the first's notification, and a route-coverage test that passes.
- [x] 4.2 OpenCode 1.x in the child: on `removed`, replay `auth.remove(target)` on the workspace's own server; on `added`, nothing. Verify with provider tests that a removal calls `auth.remove` for the target, and that an addition calls nothing.
- [x] 4.3 OpenCode 2.x in the child: replay `credential.remove` or `credential.activate` by id on the workspace's own server, ignoring a 404. Verify with provider tests for remove, activate, and a server without credential routes.
- [x] 4.4 Claude in the child: re-read the login with `accountInfo()` on a short-lived promptless session, without touching live sessions. Verify with a provider test that the login state moves, and that a live session's query receives no call.
- [x] 4.5 Bump `accountsRevision` on every accounts change and tick the inventory channel. Clients re-read `/api/chat/status` on inventory ticks, re-read the banked catalogs of an agent whose `accountsRevision` moved, and install an empty model list that follows such a change. Verify with `ui.test.ts` cases: a provider added while the picker is closed shows on its next open, and logging out of the last provider shows the empty state rather than the old list.

## 5. Login state in chat (design D7)

- [x] 5.1 Add `login` (and the `accountsRevision` from 4.5) to ready availability for both agents, counting OpenCode's free models as usable, and accept both in the page's availability validator. The status route is internal (not in the public contract), so no API revision changes. Verify with provider unit tests per state, a validation test, and CI's compatibility step passing locally.
- [x] 5.2 Claude normalization: an assistant `error` of `authentication_failed` or `oauth_org_not_allowed` marks the turn as a login failure, keeping the agent's message. `auth_status` frames are consumed into a re-authenticating indicator. Annotate both in `src/chat/claude/sdk-coverage.ts`. Verify with `normalization.test.ts` cases, and check that the coverage report no longer counts `auth_status` as unrecognized.
- [x] 5.3 OpenCode normalization: 1.x `ProviderAuthError`, and its 2.x equivalent if the 2.x probe in 7.1 finds one, mark the turn as a login failure. Verify with normalization tests for each generation.
- [x] 5.4 Chat UI:
  - the no-login notice in the new-conversation view and the composer;
  - the model picker's "no provider logged in" state;
  - the login-failure presentation of a failed turn;
  - the "Log in to <agent>" link to `/settings#agent-accounts/<agent>` in Hub-served sessions, and the agent's login command outside a Hub.

  Verify with e2e tests that pass, and take desktop and phone-width screenshots of each state through `tests/e2e/evidence.ts`.

## 6. Settings pane (design D8)

- [x] 6.1 Add the Agent accounts pane to `settingsPage` in `src/hub/pages.ts`: collapsed cards with plain-word summaries, preserved expansion, the scope statement, and the `#agent-accounts/<agent>` deep link. Before writing e2e tests, render it against the dev hub at desktop and phone widths and show it to the user. Verify by the user's review of those renders.
- [x] 6.2 Add the OpenCode provider list with a name filter (logged-in providers first), the method form renderer with `when` conditions and masked keys, informational env and command methods, and contextual errors. Verify with e2e tests: a conditional field appears only for its answer, a submitted key field is cleared, and a rejected key's error sits next to its form.
- [x] 6.3 Add the attempt view for each completion kind:
  - `device`: link plus a large code with a copy control;
  - `code`: a paste field;
  - `redirect`: the explanation plus an address field.

  Add cancel and expiry with restart, and one-second polling only while an attempt is pending. Verify with e2e tests against a fake account runtime for all three kinds and expiry, with phone-width screenshots.
- [x] 6.4 Add logout with confirmation that states the machine-wide effect, credential switching where the capability exists, and no logout action for environment or third-party Claude logins. Verify with e2e tests for each case.

## 7. Real agents

- [x] 7.1 Extend `src/chat/opencode/real-opencode.integration.test.ts` for both generations, each in an isolated `XDG_DATA_HOME`. Through the account runtime, list methods, connect a dummy key, see it from a second server, and log out: on 1.x, check that the second server drops it after the idle-gated dispose; on 2.x, use `credential.*` where answered. Record what 2.x does with a rejected key for 5.3. Verify by running it locally against 1.18.34 and the 2.x wrapper.
- [x] 7.2 Extend `src/chat/claude/real-claude.integration.test.ts` (`UATU_REAL_CLAUDE=1`) with an isolated `CLAUDE_CONFIG_DIR`:
  - `accountInfo()` reports no login;
  - `claudeAuthenticate(true)` and `claudeAuthenticate(false)` return a `manualUrl` whose `redirect_uri` is the code-callback page;
  - cancelling leaves the real `~/.claude` byte-identical.

  Verify by running it locally against the installed CLI.
- [x] 7.3 Update the coverage annotations: the OpenCode `integration.*` and `credential.*` event reasons say login changes reach a workspace through Agent accounts, and `src/chat/claude/sdk-coverage.ts` records the undeclared Claude login methods Agent accounts relies on. (The report has no axis for SDK methods, so the record is a comment there and in `ARCHITECTURE.md`.) Verified by `bun run coverage:agents`: it lists `auth_status` as handled (dedicated) and passes with the updated reasons.

## 8. Documentation

- [x] 8.1 Add an Agent accounts section to `ARCHITECTURE.md` (account runtimes, attempts, redirect confinement, propagation) and the `hub/agent-account-*` entry to the `src/` map in `CLAUDE.md`. Verify that both name the files they describe.
