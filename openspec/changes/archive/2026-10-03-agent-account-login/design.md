## Context

See proposal.md for motivation and the probe table.

How things stand today:
- **The agents run only inside workspaces.** Every agent runtime lives in a
  workspace's session child. `src/cli.ts` builds one `opencode serve` per
  workspace (cwd = the workspace) and one Claude probe plus per-conversation
  SDK sessions. The Hub process runs no agent.
- **They use the OS user's own agent stores.** Neither agent's config or
  credential location is overridden: no `XDG_*`, `HOME` or
  `CLAUDE_CONFIG_DIR` (`opencode-service.ts` `buildOpenCodeEnvironment`,
  `hub/credential-context.ts` `buildLocalCredentialEnvironment`, the Claude
  `query()` calls). Every workspace therefore shares OpenCode's store
  (`~/.local/share/opencode/auth.json` on 1.x, its own database on 2.x) and
  Claude Code's login with the user's terminal tools.
- **Catalogs are pulled, not pushed.** Clients re-read models when the
  configuration picker or a slash query opens (`ui.ts`
  `refreshCatalogsOnUse`) and never install an empty model list. The idle
  status poll stops once an agent is ready. Agent status has no login
  dimension: `ChatAvailability` is
  `idle | starting | ready | unavailable(not-installed | startup-failed | unsupported)`.
- **Auth failures arrive as raw text.** Claude's `authentication_failed`
  assistant error is never read. `auth_status` frames fall through as
  unrecognized, so the CLI's raw text lands in the timeline and the turn is
  marked failed.
- **The Hub can already call running children.** Over loopback with the
  brokered token, `hubState()` reads `/api/terminal/sessions` and the
  notifications pump reads `/api/chat/notifications/events`.

Facts probed on 2026-10-03 that shape the decisions below:
- **OpenCode 1.18.34 accepts more than its SDK declares.** `GET /provider/auth`
  returns methods with `prompts` (text and select fields, with `when`
  conditions), and `POST /provider/{id}/oauth/authorize` accepts `inputs`.
  `DELETE /auth/{id}` exists. The SDK's first client lacks these, but its
  second client (`@opencode-ai/sdk/v2`, which the 1.x provider already uses)
  declares all of them: `provider.auth`, `provider.oauth.authorize` with
  `inputs`, `oauth.callback`, `auth.set`, and `auth.remove`.
- **1.x logins: the methods split by where they complete.**
  - ChatGPT "headless" and Copilot return a device URL and code with
    `method: "auto"`.
  - ChatGPT "browser" returns an authorize URL whose `redirect_uri` is
    `http://localhost:1455/auth/callback`.
- **1.x across two servers on the same data directory:**
  - a key set through server B shows in server A's `connected` immediately;
  - a key deleted through B stays in A's `connected` until A's
    `POST /instance/dispose`.
- **OpenCode 2.0.13:**
  - `integration.list` returns `key`, `env`, `oauth` (with `id` and `form`)
    and `command` methods;
  - a key connected through B shows in A's integration connections
    immediately;
  - `credential.*` answers 404 on 2.0.13, though `@opencode/client` 2.0.21
    declares it.
- **Claude:** `claudeAuthenticate(true)` on an isolated `CLAUDE_CONFIG_DIR`
  returned `manualUrl` (redirect to `platform.claude.com/oauth/code/callback`,
  which shows a code) and `automaticUrl` (redirect to `localhost:<port>`).
  `accountInfo()` answered `tokenSource: "none"` with no login.

## Goals / Non-Goals

**Goals:**
- Logins work with no workspace running.
- One normalized login model for three different agent interfaces, so the UI
  has one form renderer and one attempt view.
- Every browser login can be completed from a device that is not the Hub
  machine.
- A changed login reaches running workspaces without a restart or an
  interrupted turn.

**Non-Goals:**
- Changing where agents store logins, or isolating them per workspace.
- Replacing the agents' own login code. Every flow is the agent's; the Hub
  only relays.

## Decisions

### D1. The Hub runs its own short-lived account runtimes

The Agent accounts service (`src/hub/agent-account-*.ts`, flat like the Hub's other families) owns one account runtime per agent, started on the
first Agent accounts request that needs it:

- **OpenCode:** an `opencode serve` spawned the way `opencode-service.ts`
  spawns a workspace's (same binary resolution, loopback, random port and
  password, same readiness probe deciding the generation), with cwd in a
  Hub-owned directory under the state dir.
- **Claude:** a promptless SDK `query()`, the same pattern as the catalog
  probe.

Both run with the Hub's environment, minus the ambient Git and SSH variables
the session child already strips. `HOME` and `XDG_*` pass through, as they do
for workspaces, so the runtime sees exactly the stores the workspaces use. A
runtime stops after 5 minutes without a request and with no attempt pending,
and when the Hub shuts down.

*Alternatives:*
- *Route through a running workspace's runtime.* Rejected. It fails exactly
  when nothing is running, which is when people log in first.
- *Write the stores directly.* Rejected. The formats are private (2.x is a
  database), and OAuth flows are agent code (PKCE, plugin device polling).

`OpenCodeService` already takes the cwd (`workspacePath`) and environment as
options, so the Hub runtime constructs one directly. Spawning and readiness
stay shared, with nothing copied.

### D2. One account adapter per agent behind a normalized model

Every account adapter implements the same operations:
`status`, `methods(target)`, `connectKey`, `startLogin`, `submitCode`,
`submitRedirect`, `cancel`, `logout`, `activate`, plus a `capabilities` set
that hides unsupported actions. There are three adapters:

- **OpenCode 1.x.** It uses `@opencode-ai/sdk/v2`, the client the 1.x
  provider already uses, which declares every operation needed.
  - After each change it resets the Hub's own server (`instance.dispose`).
    Once a 1.x instance has listed its providers, it reports a key saved
    afterwards as `custom` with no key until it reloads, which would hide
    that login's logout (found by the real-OpenCode test, 1.18.34).
  - The reset is safe there: that server has no conversation or event
    stream.
  - A saved login is recognised by `source: "api"`, or by `custom` with a
    key or with login methods of its own. The key's value is never copied.
  - The provider list is `GET /provider` (all and connected) merged with
    `GET /provider/auth`.
  - A provider without auth methods gets the implicit "API key" method,
    because `opencode auth login` offers that for any provider.
- **OpenCode 2.x.** It uses `integration.*` and, when the server answers
  them, `credential.*`. The first 404 from a `credential.*` route drops the
  `logout` and `activate` capabilities for that runtime's lifetime. `env`
  methods are shown as information ("set `GROQ_API_KEY` in the Hub's
  environment"). `command` methods are out of scope for the first cut: they
  run an arbitrary local helper whose output the user can't see, and are
  shown as "log in with `opencode auth login`".
- **Claude Code.**
  - It offers two methods: "Claude subscription" (`loginWithClaudeAi: true`)
    and "Anthropic Console" (`false`).
  - Status comes from `accountInfo()`. Login uses the undeclared
    `claudeAuthenticate`, `claudeOAuthCallback` and
    `claudeOAuthWaitForCompletion`, feature-detected on the query object.
  - Logout runs `claude auth logout` with the resolved executable.

The Hub publishes one wire form for both generations' fields: `text` or
`select` with options, `required`, `placeholder`, and an optional `when`
(field equals value). 1.x `prompts` and 2.x `form` are both mapped into it.

### D3. Attempts are Hub objects with a server-side waiter

`startLogin` creates a Hub attempt `{id, agent, target, method, url,
instructions, completion, state, expiresAt}`, keyed by agent and target. A
new attempt for the same key cancels the old one.

`completion` says how the user finishes:
- `device`: nothing to paste. The URL has no loopback `redirect_uri`, or the
  agent marks the method as polling.
- `code`: paste a code. This covers 1.x `method: "code"`, 2.x `mode: "code"`,
  and Claude, which always uses `manualUrl`; the pasted `code#state` is split
  before `claudeOAuthCallback`.
- `redirect`: the URL's `redirect_uri` is a loopback address, so the user
  pastes the address the browser landed on.

The Hub then drives completion itself:
- 1.x `auto`: a blocking `POST /provider/{id}/oauth/callback {method}`.
- 2.x: `integration.oauth.status` polled every second.
- Claude: after the code is submitted, `claudeOAuthWaitForCompletion()`.

The waiter settles the attempt to `complete`, `failed` (with the agent's
message) or `expired` (at the agent's deadline, or 10 minutes when the agent
states none). The runtime stays alive while an attempt is pending.

The page polls `GET /api/hub/agent-accounts` every second while an attempt is
pending, and stops otherwise. This avoids a new live-stream topic for a page
that does not open the stream today.

*Alternative:* a live-stream topic. Rejected for now: the Settings page has
no stream connection, and the polling cost is bounded by pending attempts.

### D4. Redirect delivery is confined to the attempt's own callback

For a `redirect` attempt, the Hub records the parsed `redirect_uri` when it
starts the attempt. A pasted address is delivered only if it parses as
`http:` with a loopback host (`localhost`, `127.0.0.1`, `[::1]`) and the
same port and path as the recorded callback. The Hub then makes one `GET`
with `redirect: "manual"`, a 10 s timeout, and the body discarded. Success is
judged by the attempt settling, not by the listener's status.

This is a fetch to a user-supplied URL, so it is confined to the one listener
the agent opened for this attempt and is never made without an attempt in
progress.

### D5. Hub endpoints

The new endpoints are public Hub operations:
- `GET /api/hub/agent-accounts`: agents, status, methods and attempts.
- POST mutations under `/api/hub/agent-accounts/…`: `key`, `login`,
  `attempts/{id}/code`, `attempts/{id}/redirect`, `attempts/{id}/cancel`,
  `logout`, `activate`.

They follow `api/CONVENTIONS.md`: `operations.yaml`, closed schemas in
`openapi.yaml`, examples, and a changelog entry. Mutations sit behind the
existing auth and CSRF gate. The request-body logger, if any, never sees these
bodies, and validation errors name the field, never its value.

The Hub API revision changes only if an existing object changes. New
operations are additive.

### D6. Running workspaces are told; they replay the change, never restart

After a successful key, login, logout or activate, the Hub POSTs a new
internal child route, `POST /api/chat/accounts-changed`, to every running
session. The body is `{agentId, change}`, where `change` is one of:
- `{kind: "added"}`;
- `{kind: "removed", target, credential}`;
- `{kind: "activated", credential}`.

The Hub runs one agent's login changes one at a time and finishes notifying
before the next starts. Each child then:

- **OpenCode, added:** nothing to do. A login saved by another server shows
  in this server's provider list and integrations on the next read (probed on
  1.18.34 and 2.0.13).
- **OpenCode, removed or activated:** replays the same operation on its own
  server: 1.x `auth.remove(target)`; 2.x `credential.remove` or
  `credential.activate` by id. The store already reflects the change, so the
  replay is a no-op on disk, and it updates that server's in-memory state.
  - *Why replay:* probes disagreed on whether a removal made through another
    server is seen without help (once it stayed until the instance was reset,
    once it showed at once).
  - *Why not reset instead:* `POST /instance/dispose` was rejected because it
    ends the provider's directory-scoped event stream.
  - *Why serialize:* a 1.x replay keyed by provider could delete a newer
    login, so the Hub finishes notifying before the next change for that
    agent.
- **Claude:** re-reads the login (`accountInfo()` on a short-lived
  promptless session). New conversations start new CLI processes and pick up
  the new login. A live session keeps the credentials its process loaded
  until it ends.

Each ready agent's availability carries an `accountsRevision`, a counter the
child bumps on every accounts change. The child also ticks the conversation
inventory channel, which clients already receive over the brokered live
stream. On every inventory tick a client re-reads `/api/chat/status`, which
is in-memory and cheap. When an agent's `accountsRevision` moved, the client
re-reads that agent's banked catalogs, and installs the answer even when it
is empty, so logging out of the last provider shows the "no provider logged
in" state instead of the old list. This adds no new stream event type: the
live broker emits a fixed inventory payload, and the revision rides the
availability object D7 already changes.

Child routes are internal (`api/exclusions.yaml`), so this adds no public
operation.

### D7. Login state rides availability

`ready` availability gains
`login: { state: "ok" | "missing" | "unknown"; source?: … }`.
- **Claude:** `missing` when `accountInfo()` reports no token and no API key
  source on a first-party provider, `unknown` when the read fails.
- **OpenCode:** `missing` when no provider (1.x) or integration (2.x) is
  connected and no free model is offered.

The 2.x free `opencode/*-free` models count as usable, so a fresh 2.x install
is not shown as logged out. `ChatAvailability` travels only on the internal
child route `/api/chat/status`, which is outside the public contract (it is
listed in `api/exclusions.yaml`), so neither field changes a public API
revision. The page's own validator accepts both, and a page from an older
build reloads through the client-freshness handshake, because its version
or commit differs.

Turn failures are classified as login failures in normalization:
- Claude: an assistant frame with `error: "authentication_failed"` or
  `"oauth_org_not_allowed"`.
- OpenCode: 1.x `ProviderAuthError`, and its 2.x equivalent where the probe
  finds one.

`auth_status` frames are consumed: while `isAuthenticating` is true, the
turn shows the agent re-authenticating rather than unrecognized output. Both
`sdk-coverage.ts` files are annotated.

### D8. Settings UI lives in `pages.ts` like Credentials

An Agent accounts pane is added to `settingsPage` with its own inline client
module:
- collapsed cards per agent;
- the OpenCode provider list with a filter field, logged-in providers first;
- one method-form renderer driven by D2's field model;
- one attempt view per `completion` kind.

`/settings#agent-accounts/<agent>` expands that card. This is the chat's
deep link: a session page reaches it at the Hub origin, and outside a Hub
there is no link, so the chat names the agent's login command instead.

The redirect field explains in one sentence why the page will fail to load
and what to paste. Methods that complete only with a pasted address are
labelled "paste the address you land on", so a phone user can choose a
device method instead (ChatGPT headless rather than browser).

## Risks / Trade-offs

- **Claude login methods are undeclared and could change or vanish in any
  SDK release.** → They are feature-detected. If they are missing, the card
  says "log in with `claude auth login` in a terminal" and still shows status
  from the declared `accountInfo()`. The real-CLI integration test
  (`UATU_REAL_CLAUDE=1`) asserts the URLs' shape against an isolated
  `CLAUDE_CONFIG_DIR`, and the coverage report lists the methods as
  undeclared.
- **OpenCode 1.x prompt types may grow.** → Prompts are parsed defensively;
  unknown prompt types fall back to text. A
  real-OpenCode integration test runs against an isolated `XDG_DATA_HOME`.
- **A second OpenCode server on the same data directory.** In one probe, two
  1.x servers started at the same instant and one failed to come up; started
  one after the other, both worked. → The account runtime's startup is
  retried once, then reported on the card with Retry. Workspace servers
  already handle their own startup failures.
- **OpenCode 2.x versions differ in what they answer.** → Capabilities are
  detected per runtime, and missing actions are hidden, not errors.
- **A live Claude session keeps old credentials until it ends.** → This is
  acceptable. A logout followed by a new login is the rare case, and new
  conversations use the new login.
- **The Hub fetches a user-pasted URL.** → D4 confines it to the attempt's
  own loopback callback. Tests cover refusal of other hosts, ports, schemes,
  and requests with no attempt pending.
- **Every Hub user can change machine-wide logins.** This was accepted. The
  page states the scope.

## Migration Plan

Nothing to migrate: logins already in the agents' stores show up as logged
in. Rollback means removing the pane and endpoints. Logins made through the
Hub remain in the agents' stores and keep working.
