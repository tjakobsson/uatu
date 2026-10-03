## Why

UatuCode chat runs on whatever logins OpenCode and Claude Code already have on
the Hub machine. When one is missing or expired, the only way to fix it is
outside UatuCode: open a terminal, start the agent's TUI or run
`opencode auth login` / `claude auth login`, and finish there. From a phone or
a remote browser that means a terminal session on a small screen, for
something both agents already expose as an API. Nothing in the chat says a
login is the problem either. An OpenCode provider that isn't logged in leaves
the model picker without saying why, and a Claude turn without a login fails
with the CLI's raw error.

Both agents can be logged in programmatically. Probed 2026-10-03 against
OpenCode 1.18.34, `@opencode/client` 2.0.21, Claude CLI 2.1.281 and agent SDK
0.3.286:

| Agent | Status | API key | Browser login | Log out |
|---|---|---|---|---|
| OpenCode 1.x | `GET /provider` (`connected`), `GET /provider/auth` (methods with form prompts) | `PUT /auth/{provider}` | `POST /provider/{id}/oauth/authorize` (with `inputs`) → `{url, method: auto\|code, instructions}`, then `/callback` | `DELETE /auth/{provider}` |
| OpenCode 2.x | `integration.list` (methods + connections), `credential.list` | `integration.connect.key` | `integration.oauth.connect / status / complete / cancel` | `credential.remove`; `credential.activate` switches |
| Claude Code | `accountInfo()` (email, org, plan, token source, provider) | Console login creates a managed key (same flow as browser) | `claudeAuthenticate(loginWithClaudeAi)` → `{manualUrl, automaticUrl}`, `claudeOAuthCallback(code, state)`, `claudeOAuthWaitForCompletion()` | CLI only: `claude auth logout` |

What the probe showed about the browser logins:
- **Device-code logins** (ChatGPT "headless", GitHub Copilot) answer a public
  URL and a code to type, and work from any device.
- **Claude's `manualUrl`** redirects to `platform.claude.com`, which shows a
  code to paste back. That works from any device too.
- **Some logins only work on the Hub machine.** ChatGPT "browser" and Claude's
  `automaticUrl` redirect to `localhost` on the Hub machine, so they only
  complete when the browser runs on that machine.

The Claude login calls are present in the SDK and the CLI answers them, but
they are not in the SDK's published type declarations.

## What Changes

- **Agent accounts on Settings.** The Hub's `/settings` page gains an Agent
  accounts area. It lists each agent, and for OpenCode each provider, with its
  login state: who is logged in and how (account, plan, API key, OAuth)
  where the agent says so, or "Not logged in". It is the one place logins are
  managed.
- **API key login.** For a provider or agent method that takes a key, a
  masked key field plus the method's own extra fields (OpenCode's prompts,
  e.g. Cloudflare account id, GitLab instance URL), submitted to the agent.
  UatuCode never stores or redisplays the key.
- **Browser login.** Starting a login shows the URL to open and the agent's
  instructions (a device code, for instance) and then follows the attempt to
  completion, failure, or expiry. Where the agent's flow ends with a code to
  paste, a field takes the code. Where it redirects to `localhost` on the Hub
  machine, a field takes the address the browser landed on, and the Hub
  delivers it to the agent's local listener. Every browser login therefore
  completes from a remote device, whichever kind it is. A login can be
  cancelled.
- **Log out and switch.** Log out an OpenCode provider (1.x and 2.x) or the
  Claude Code login. Claude has no SDK call for it, so the Hub runs
  `claude auth logout`. On OpenCode 2.x, switch the active credential when an
  integration has more than one.
- **Machine scope, stated.** Logins are written to the agents' own stores
  (OpenCode's credential store, Claude Code's login), not to UatuCode. They
  apply to every workspace on the Hub, every Hub user, and the agents' own
  TUIs on that machine, and the page says so. There are no per-user or
  per-workspace logins.
- **Chat picks up a login without a restart.** After a login or logout, open
  workspaces refresh that agent's model catalog and availability. A provider
  that just logged in appears in the picker without restarting the workspace.
- **Chat points at the fix.** When a Claude turn fails because there is no
  usable login, or OpenCode has no provider logged in, the chat says so and
  links to Agent accounts instead of showing only the CLI's error.

### Non-goals

- Per-user or per-workspace agent logins, or projecting agent keys into a
  workspace's environment the way Hub provider-CLI credentials are.
- Storing any agent secret in UatuCode's own state.
- MCP server OAuth (both agents have separate APIs for it).
- Claude Code logins through a third-party provider (Bedrock, Vertex,
  Foundry). Those authenticate through the cloud provider's own tooling, and
  the area reports them as configured outside UatuCode.

## Capabilities

### New Capabilities

- `agent-accounts`: viewing and managing the Hub machine's agent logins:
  status per agent and provider, API key, browser and device-code logins
  (including completing localhost-redirect flows from a remote browser),
  log out, credential switching, machine-scope disclosure, and the refresh
  that makes a changed login visible to open workspaces.

### Modified Capabilities

- `hub-dashboard`: Settings gains an Agent accounts area next to
  Credentials, and the chat in a Hub-served session links a missing login to
  it.
- `opencode-chat` and `claude-code-chat`: the rule that UatuCode never
  requests provider keys is narrowed. A workspace's chat still never asks for
  one, and keys and logins are accepted only through Agent accounts, handed
  straight to the agent's own login interface, and never stored, logged, or
  returned by UatuCode.
- `chat-agents`: a ready agent reports whether it has a usable login. A
  missing or rejected login is presented as such, in the new-conversation
  view, the composer, the model picker, and a failed turn, instead of as an
  unexplained error or an empty picker.

## Impact

- **Hub:** a new Agent accounts service (`src/hub/agent-account-*.ts`) that starts its own
  short-lived OpenCode server and Claude session on demand. Today agent
  runtimes exist only inside running workspaces, and logins must work with
  none running. It adds `/api/hub/agent-accounts` endpoints (POST mutations
  under the existing same-origin rule, with changelog entries) and the
  `/settings` pane. It also tells running workspaces about changed logins
  through a new internal child route.
- **Agents:** `src/chat/opencode/` (both generations) and `src/chat/claude/`
  gain account reads and login operations behind the provider seam, plus a
  catalog refresh trigger after a login changes.
- **Chat:** `login` and `accountsRevision` fields on ready availability
  (internal child protocol, no public API revision change), login-failure
  classification of failed turns, and a client re-read of status and
  catalogs when logins change.
- **Coverage:** the OpenCode and Claude `sdk-coverage.ts` annotations move the
  auth, integration, and credential operations from "not used" to used. The
  Claude login calls are recorded as relying on undeclared SDK methods.
- **Risk:** the Claude login methods are undeclared in the SDK's types and
  could change without notice. The design keeps them behind one adapter, with
  a fallback that sends the user to `claude auth login` in the workspace
  terminal.
