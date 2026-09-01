# Chat

Chat is a workspace-scoped web client for coding agents you have already
installed and authenticated yourself. It bundles no agent, configures no
model provider, and holds no provider credentials. Two agents are offered
today — **OpenCode** and **Claude Code** — and every conversation belongs
to exactly one of them, chosen when the conversation is created and fixed
for its life. One agent being missing or broken never blocks the other.

## Prerequisites

### OpenCode

1. Install a compatible `opencode` executable by following the
   [OpenCode installation guide](https://opencode.ai/docs/).
2. Run `opencode` as the same operating-system user that runs `uatu`.
3. In OpenCode, use `/connect` to authenticate a provider and `/models` to
   choose a model. Confirm a normal OpenCode prompt works before using Chat.
4. Ensure `opencode --version` succeeds in the environment that starts the
   uatu hub or direct server. A service manager may have a different
   `PATH`, `HOME`, or provider environment from an interactive shell.

### Claude Code

1. Install the `claude` CLI by following the
   [Claude Code installation guide](https://code.claude.com/docs/).
2. Run `claude` once as the same operating-system user that runs `uatu`
   and sign in, so the install is authenticated.
3. Ensure `claude --version` succeeds in the environment that starts the
   uatu hub or direct server.

Each agent owns its configuration, authentication, and durable session
history. uatu never asks for, copies, transmits, or stores provider API
keys. UatuCode Desktop's Keychain contains only hub login credentials and
hub session identifiers, not agent or model-provider secrets.

## Lifecycle And Workspace

The two agents run differently, and Chat starts neither until a
conversation actually needs it — opening Chat only reports availability.

**OpenCode** runs as one password-protected server bound to an ephemeral
`127.0.0.1` port inside the uatu workspace process, started when an
OpenCode conversation is first needed. The private endpoint and password
are never sent to a browser or exposed by the hub.

**Claude Code** has no long-lived service. Availability is a bounded
`claude --version` probe; each conversation with an active turn runs as
its own Claude Agent SDK session against your installed `claude`, and an
idle conversation holds no process. Conversations resume from Claude
Code's own session storage (`~/.claude/projects/...`), which uatu reads
but never writes.

The canonical first watched root is the immutable working directory for
both agents. For a direct multi-root command, later roots remain available
to Preview but Chat uses only the first root. Browser requests cannot
select another working directory, and conversations belonging to another
canonical directory are not listed or accepted.

Stopping the uatu workspace stops its OpenCode child and any live Claude
Code sessions, ending their active turns. Completed history remains in
each agent's own storage and is available when the workspace starts
again. Closing a browser, PWA, or UatuCode Desktop window does not stop a
hub workspace.

## Access And Authority

Direct `uatu serve` access uses the same short-lived workspace credential
and HttpOnly cookie as the embedded terminal. Chat reads and mutations
require that credential, and mutations also require a same-origin request.

With `uatu hub`, users authenticate to the hub. The hub brokers the child
workspace credential and proxies Chat HTTP and SSE traffic under
`/s/<workspace-id>/`; it does not expose any loopback agent service.
Hub users share the authority of the operating-system account running the
hub.

An agent can read files, execute commands, and modify anything that the
daemon's OS user can access. uatu workspace membership and an agent's
permission prompts are not an OS sandbox. Claude Code's
`bypassPermissions` mode is not offered unless the workspace operator
explicitly enables it. Do not give mutually untrusted users access to one
hub account or daemon user. See [Self-hosting](./SELF-HOSTING.md) for the
complete trust model and network guidance.

## Troubleshooting

- **An agent is not installed:** its executable was not found on the
  server process's `PATH`. Verify it from the service account and restart
  the workspace after correcting `PATH`. The other agent keeps working.
- **OpenCode could not start:** run `opencode serve --hostname 127.0.0.1
  --port 0` as the daemon user and inspect its diagnostic. Check
  executable permissions, configuration syntax, and service-manager
  environment.
- **Claude Code could not start:** run `claude --version` as the daemon
  user; the Chat diagnostics panel carries the probe's captured output.
- **Installed version is not compatible:** upgrade the agent, then use
  Retry on its unavailable panel — a retry restarts only that agent.
- **A prompt fails or no model is available:** run the agent directly and
  verify its provider authentication (`/connect` and `/models` in
  OpenCode; sign in again in Claude Code). Provider failures do not
  disable Preview, Files, Search, Terminal, or the other agent.
- **A conversation is missing:** sessions are filtered to the canonical
  first root. Confirm the agent created the session in exactly that
  workspace directory.
- **Chat reconnects or requests resync:** a brief disconnect replays
  retained events. A workspace restart or a long retention gap requires a
  fresh history snapshot automatically; completed agent history is not
  deleted.
- **Hub Chat is unauthorized:** sign in again and verify the workspace is
  running. Do not proxy a child session directly or rewrite its base path.

## Vocabulary

Three words, three meanings. They are used this way in the UI, in the
specs, and in the route table.

- **agent** — a program Chat talks to: OpenCode or Claude Code. Every
  conversation names its owning agent, and conversation ids are
  agent-qualified on the wire.
- **mode** — how an agent is asked to work: OpenCode's Build and Plan,
  Claude Code's permission modes (`auto`, `default`, `acceptEdits`,
  `plan`; `auto` is the declared default a fresh conversation starts in).
  Listed per agent at `/api/chat/modes?agent=...`. OpenCode calls these
  agents on its own wire; uatu does not, because the word is taken.
- **subagent** — an agent the agent spawned inside a turn. What the
  pinned bottom track shows, and what opens as a drill-down transcript.

An agent declares what it can do, and Chat presents a control only when
the capability behind it is declared. A capability is declared positively:
it is in the agent's list, or the agent does not have it. There is no
"false" and no "unknown", so an absent control means the agent cannot do
that thing — not that it failed, and not that it is empty.

## Scope

OpenCode and Claude Code are the agents currently declared. This
integration does not implement ACP, Codex, session sharing, or a native
SwiftUI chat renderer, and it does not import Claude Code sessions
recorded under other working directories. Another agent may be added
behind uatu's normalized API; each agent's own provider support remains
configured and authenticated through that agent.

Chat surfaces the models each agent has available — OpenCode's configured
providers, Claude Code's model catalog with per-model effort levels — and
offers each agent's own slash commands. Neither adds a provider or
credential of its own: authentication stays with the agent.
