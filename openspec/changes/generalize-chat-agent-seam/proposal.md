# Generalize the chat agent seam

## Why

Chat serves two agents, but parts of the shared code still assume exactly
OpenCode and Claude Code. Turn liveness for image capture reads each agent's
private markers, the Claude Code runtime cannot be reused for another
command-line agent, login guidance is a hard-coded table that always points to
the Hub's Settings, pending interactions live inside the Claude Code provider,
and the end-to-end harness can route to only two fakes. Adding a third agent
(planned next: Antigravity, in `add-antigravity-chat`) would otherwise copy
each of these special cases again.

CONTRIBUTING.md reserves OpenSpec for behaviour and workflow changes. This
change exists by explicit decision, so the refactor is reviewed as one plan
before the third agent builds on it. Its specs record only the few rules that
become observable; the refactors themselves are described in `design.md` and
`tasks.md`.

## What Changes

- Shared code decides whether a reply is still live from four agent-neutral
  facts that each agent's normalizer supplies, instead of reading OpenCode and
  Claude Code markers by name. Stored image captures keep their identities.
- A generic runtime for agents found on `PATH` replaces the Claude Code-only
  runtime. The lazily started chat service no longer assumes OpenCode: each
  agent passes its own runtime, and its startup messages name that agent.
- Each agent declares its login command and whether the Hub manages its login.
  Chat links to the Hub's Settings only for a Hub-managed login; otherwise it
  shows the agent's own command. One constant per agent replaces the duplicated
  login commands in chat and the Hub. Copy that names a fixed agent is
  corrected.
- Pending permission and question requests move into a shared holder that any
  provider can use. Claude Code behaves as before apart from these approved
  differences (design D4):
  - a request redelivered while its original waits replaces it, and the
    original now settles quietly instead of hanging; a late abort of the
    original no longer removes the replacement;
  - a request from a session already swept or retired, or one arriving during
    shutdown, ends at once with its abandoned result and announces nothing;
  - a session displaced by a racing start is swept and closed on disposal,
    and its own requests are swept when its stream ends;
  - cleanup is per session: when two queries for one conversation race,
    ending one never abandons another query's requests while it still runs;
  - approving a displaced query's plan switches only that query: no
    `plan.approved` is emitted and the conversation's mode stays unchanged;
  - committing a staged revert sweeps any request the interrupt left pending
    before the replacement starts.
- The end-to-end harness routes requests to any number of fake agents keyed by
  agent id.
- **BREAKING** for strict workspace API validators: the agent descriptor gains
  its login declaration. The workspace API revision and the bundled web
  revision are bumped.

OpenCode behaves as it does today. Claude Code does too, apart from the approved
differences listed above and the deliberate differences design D4 records for
workspace shutdown and prompt delivery (such as a revert's replacement being
acknowledged only once Claude Code has taken it). Beyond those, the only visible
differences are startup messages that name the agent that failed and corrected
agent names in two pieces of copy.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-agents`: login guidance follows each agent's declaration (a Hub
  Settings link only for a Hub-managed login, otherwise the agent's own
  command), and startup failure messages name the agent that owns them.
- `agent-accounts`: the Agent accounts area lists the agents whose login the
  Hub manages, rather than every offered chat agent.

## Impact

- **Code**: `src/chat/agents.ts`, `src/chat/adapter.ts`,
  `src/chat/visual-identity.ts`, both agents' `normalization-types.ts` and
  normalizers, `src/chat/service.ts`, `src/chat/claude/runtime.ts` (becomes a
  configuration of a new generic runtime), `src/chat/opencode/opencode-service.ts`
  (process helpers lifted out), `src/chat/claude/provider.ts` (pending
  interactions and push queue lifted out), `src/chat/login-action.ts`,
  `src/chat/composer-status.ts`, `src/chat/ui.ts`, `src/cli.ts`,
  `src/hub/agent-account-service.ts`, `src/hub/agent-account-claude.ts`,
  `src/hub/agent-account-opencode-v2.ts`, `src/hub/agent-account-runtime.ts`,
  `tests/e2e/server.ts`.
- **API contract**: `ChatAgentDescriptor` is a closed object, so its new
  `login` field needs a workspace revision bump, the matching
  `api/contract.json` and OpenAPI `x-uatu-revisions` entries, and an
  `api/CHANGELOG.md` entry with migration guidance. `BUNDLED_WEB_REVISION`
  moves too, because a cached web client's validator rejects the new field.
- **Dependencies**: none.
- **Docs**: `ARCHITECTURE.md` chat sections and the `CLAUDE.md` folder map
  name the new shared modules.
