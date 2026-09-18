## Why

Plan usage for Claude Code exists only as a by-product of a turn: the provider reads the SDK's `/usage` answer once, after each result, and attaches it to that turn's `context_report`. That item has no durable home — Claude Code's transcript never carries it, so it lives only in the workspace process's in-memory projection and in a client module variable. Switching workspaces (a full navigation), reloading, a restarted workspace, or a projection evicted from the cache leaves the Usage pane empty and the composer chip hidden until the next turn ends (#387). A conversation that is busy with a long background task, the case where usage matters most, has no next turn to wait for. The rate-limit standing, by contrast, is kept per session across query retirement, so a reopened conversation can show "Near rate limit" with no windows under it — the "partially loaded" panel in #389 is the same defect seen from the readout.

Usage should be something the user can ask for, and something the app remembers.

## What Changes

- **The workspace keeps the newest plan report.** The Claude provider holds one last-known usage report per workspace process — the plan windows, when they were read, and which conversation they were read through — updated by every read (turn-end or on demand), persisted in the provider's durable state, and restored when the workspace starts. Plan usage is per login, not per conversation, so one report serves every conversation in the workspace.
- **The pane and the readout paint from it on open.** A reloaded page, a returned-to workspace, or a conversation without a report of its own shows the last-known windows with their age ("as of 21:33 · 12 min ago"). Past a staleness threshold the figures are marked stale, still readable. A rate-limit standing without a fresh report shows beside the last-known windows instead of alone.
- **A refresh control** in the Usage pane and in the composer's plan readout asks for a read now. A live Claude session (a turn in flight, background tasks running) answers from its own query without interrupting it; an idle conversation is started for the read and retired again; a workspace with no Claude conversation reads through a short-lived, unlisted probe query. While reading, the control says so; a failed read keeps the figures and says why.
- **Free refreshes happen unasked.** Opening the pane or the readout when the report is stale and a Claude session is already live refreshes through that session. A process is only ever started by an explicit click.
- **The empty state changes** from "Plan usage appears here after a Claude Code turn" to an invitation to read now.
- Every read produces the same `context_report` item a turn-end read produces (context breakdown, plan, conversation totals) in the conversation it went through, so the context readout refreshes with it. No new item type, no new field on a published item.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `claude-code-chat`: the requirement *Session signals surface as status, not silence* gains the last-known plan report — held by the workspace, restored on start, presented with its age, refreshable on demand through a live or a started session — and the rule that a rate-limit standing never displaces the last-known windows.
- `sidebar-shell`: *The sidebar hosts a Usage pane in the pane stack* is revised: the pane shows the workspace's last-known report on load with its age and staleness, offers a refresh control, and its empty state invites a read rather than waiting for a turn.

## Impact

- `src/chat/provider.ts` — the `ChatProvider` seam gains two optional methods: the last-known usage report and an on-demand read.
- `src/chat/claude/provider.ts` — the last-known report (durable state field, restore, update on every read); the on-demand read's session choice (live → most recent idle, started and retired → unlisted probe query); the read itself reuses `readPlanUtilization` and the context probe without disturbing turn-end probe generations or retirement.
- `src/chat/adapter.ts`, `src/chat/service.ts`, `src/server/routes.ts`, `src/chat/client.ts` — a usage read route pair (last-known + refresh) under `/api/chat/`, internal like every child route (already covered by the `workspace-api` exclusion; no contract revision).
- `src/chat/usage-pane.ts`, `src/chat/ui.ts`, `src/chat/composer-status.ts`, `src/index.html`, `src/styles.css` — seed from the last-known report on init, age and stale treatment, refresh controls and their in-flight / failure states, readout fallback to the last-known plan.
- `tests/e2e/chat-service.ts` — the e2e double gains the two service methods; e2e coverage in `chat-claude-polish.e2e.ts` (readout refresh, standing + last-known) and `sidebar.e2e.ts` (pane survives reload, refresh control, stale age).
- Unit tests colocated with each touched module; `claude/provider.test.ts` for the session choice and durable restore.
- Issues closed: #387, #389. OpenCode conversations are unaffected (no plan data).
