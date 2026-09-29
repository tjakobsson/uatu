## Context

See proposal.md for motivation. The facts that shape the approach, verified against the `v2` branch of `anomalyco/opencode` and `@opencode/client` 2.0.x:

- 1.x: `command.list` returns commands and skills together, skills tagged `source: "skill"`; `session.command` executes either by name. The v1 provider maps `source` to `kind: "skill"`.
- 2.x: `command.list` (`GET /api/command`) returns only config commands, schema `{name, description}`. Skills are their own catalog, `skill.list` (`GET /api/skill`) → `{id, name, description, autoinvoke, path, content}`. `session.command` executes config commands only. A skill is invoked by attaching it to a prompt: `session.prompt({ text, skills: [{ id, name, mention }] })`; the server resolves the id, loads the SKILL.md, and adds it to the user turn. OpenCode's own clients insert `@<skill-id>` into the text with the mention range pointing at it. There is also `POST …/session/:id/skill` (`session.skill`), which activates a skill and resumes the run but takes no arguments.
- 2.x: `location.reload()` (`POST /api/location/reload`, no body) tears down and rebuilds every location's services (config, agents, commands, skills, models, …). A running turn observes the rebuild as a `Reloaded` drain result and continues. Services publish `agent.updated`, `command.updated`, `skill.updated`, `model.updated`, `config.updated` as they rebuild; uatu's 2.x normalization lists all of these as ignored.
- uatu: the palette's commands come from `listCommands()` per agent and are banked in `agentCatalogs` (`src/chat/ui.ts`); a background refresh (`refreshBankedCommands`) re-reads commands and models on the idle poll and after a selection settles, but not modes. A slash command of kind `command` reaches `provider.command()` over the existing chat command route; the v2 provider already has an `inject()` path that puts provider-made events (notice rows, status) on the conversation stream — used today for a refused command.
- The chat routes are the session child's, classified internal by the API contract; conversation events and items on the live stream are versioned by the workspace revision. Nothing here adds an item type, event type, or route.

## Goals / Non-Goals

**Goals:**
- Skills in the 2.x palette with the same shape 1.x reports (`kind: "skill"`), dispatched as OpenCode 2.x dispatches them.
- `/reload` as a built-in with a visible outcome and catalogs that follow it, without touching the wire.
- Keep 1.x behaviour byte-for-byte except the palette label.

**Non-Goals:**
- `@skill` autocomplete in the composer (a later change can add it; the mention text is already what 2.x expects).
- A skills inspector (#465) beyond the palette label.
- Reload confirmation or per-conversation reload; OpenCode's operation is server-wide and its own TUI asks nothing.
- Reacting to `*.updated` stream events for catalog refresh (see Decisions).

## Decisions

**D1. Skill dispatch = prompt with a `skills` attachment and `@<id>` text, not `session.skill`.**
`session.skill` takes no arguments and only activates the skill, so `/skill args` cannot be expressed through it. The prompt form is what OpenCode's app and TUI send, the server resolves the skill by id and stores the attachment on the user turn, and the text `@<skill-id> <args>` reads correctly in the timeline and on history replay with no new item type. The mention range covers the `@<skill-id>` token (start 0, end its length). Alternative considered: `session.command` with the skill name — 2.x's command executor does not know skills; it would be refused.

**D2. The palette's name is the skill's id.**
`skill.list` returns both `id` and `name`; the id is what the mention and the attachment key on, and it is what OpenCode's own clients display (`@<id>`). The client's prompt input takes a skill attachment as `{ id, mention }` only; the server resolves the name from the id. Where id and name differ, the palette description leads with the name.

**D3. What a slash name runs is decided by the listing the text was classified against.**
The adapter parses a slash text against a fresh `listCommands()` just before calling `command()`, and hands the entry it matched to `command()` as `listed`; the v2 provider dispatches by that entry (built-ins recognised by identity, skills and config commands by kind — the palette's precedence having already been applied when the listing was built), without a second catalog read. A catalog entry removed or shadowed between the two therefore still goes out as what the user chose and is refused by OpenCode if gone, instead of falling through to a same-named built-in. Review of #475 drove this in two steps: a second catalog read at dispatch, then a provider-wide "latest listing" that a concurrent read could replace, both reopened the window; the per-dispatch entry closes it. A skill already gone when the adapter parses is not a command at all, so the text is sent as prose, uatu's rule for any unknown `/name` (spec corrected after review; carrying the palette's classification through the held queue was judged not worth the adapter change). A name the provider never listed is read fresh.

**D4. `/reload` is a provider built-in on the existing command route.**
Like `compact`, `reload` is a `BUILTIN_COMMANDS` entry of the v2 provider and is absent from v1's list, so capability gating falls out of the inventory: no new capability flag, no new route, no API revision. `command()` recognizes it, calls `location.reload()`, and reports through `inject()`: on dispatch, remove the optimistic user row and upsert a notice "Reloading configuration…" with status `running`; on resolution, replace it with "Configuration reloaded" and status `idle`, or an error notice with OpenCode's message and status `failed`. Alternative considered: a `local-operation` kind with a dedicated workspace route, as undo/redo use. That is a route addition and a second code path in the UI for something the provider can answer in one call; rejected.

**D5. Catalog refresh after reload is client-driven, not event-driven.**
The invoking client knows it submitted `/reload` and sees the success notice; on that outcome it drops the agent's banked catalogs and re-reads commands, models, and modes through the existing catalog load, then re-renders the configuration and the palette. Other open clients re-read the same catalogs where they are used: starting a slash query or opening the configuration picker refreshes commands, models, and modes in the background (each open issues its own read; only the latest read's answers are installed), and the open surface re-renders when the lists land. The idle poll cannot carry this: it stops once the agent is ready. (Review of #475 caught the first version's reliance on it.) Alternative considered: mapping 2.x's `*.updated` stream events to a "catalogs changed" signal. That needs a new event on the versioned live stream (a workspace revision bump) and a per-agent debounce for a burst of five events; deferred, and D5 covers the reporter's case without it.

**D6. The reload notice is the invoking conversation's only.**
`location.reload()` is not tied to a session, so no other conversation is told. This matches OpenCode's TUI (a toast in the invoking client) and the spec's "the conversation in which `/reload` was submitted".

**D8. Reload success waits for the rebuilt catalogs, not the `204`.**
Found against a real 2.0.13 server: `location.reload` answers `204` right after `location.shutdown` and rebuilds the location afterwards; until the rebuild's burst of `*.updated` events (about 140 ms later), `skill.list` returns nothing at all — not even the built-in skills. D5's re-read on the success notice would then have banked a palette with every skill missing. So the provider arms a waiter before calling reload, arms it on the workspace's own `location.shutdown`, and reports success once that workspace's `command.updated` and `skill.updated` have both followed; another directory's events and announcements before the shutdown are ignored. The wait is bounded (10 s): with the stream down, or a server that announces differently, success is still reported (the reload did happen) and the idle refresh catches up. A failed call is reported at once. Alternative considered: polling `skill.list` until it is non-empty — a workspace can legitimately have no skills, and the first rebuilt read can be partial.

**D7. Precedence when names collide: config command > skill > built-in.**
1.x's server applies the first two (`if (commands[item.name]) continue` when folding skills in); uatu applies the same on 2.x when it merges the catalogs, and the built-ins yield to both, as they do today.

## Risks / Trade-offs

- [A skill invoked with no arguments sends a prompt whose text is only `@<skill-id>`] → OpenCode's own TUI allows a submit with a skill part and no other text; the server treats it as a normal turn. Verified against a real 2.x server as a PR-time step.
- [History replay of a skill turn shows `@<skill-id> args`, not `/skill-id args`] → Accepted: it is what the model was sent and what OpenCode's app shows; the spec pins the `@` form.
- [`location.reload()` rebuilds every location the server hosts, not just this workspace's] → A uatu-spawned OpenCode serves one directory, so the blast radius is the workspace. Stated in the notice copy ("Reloading OpenCode configuration…").
- [Reload takes seconds and the command admission window is one second] → `reload` bypasses the admission race: the provider awaits the call itself (bounded by the client's request timeout) and reports through injected events, so the caller is told "admitted" immediately and the outcome arrives as events, like a refused command does today.
- [A reload failure leaves OpenCode with a half-built location] → Out of uatu's hands; the failure notice carries OpenCode's message (the client rejects with the decoded tagged error, a plain object with `message`), and `/reload` can be run again.
- [Both catalogs are read on every slash dispatch] → Two small GETs in parallel; the palette read already makes them.

## Open Questions

None that change the specs or the task breakdown.
