## Why

On an OpenCode 2.x workspace the slash palette has no skills: `/skill-name` is gone, and typing it sends the text as an ordinary prompt. OpenCode 2.x moved skills out of the command list into their own catalog (`skill.list`) and attaches them to prompts as `@skill` mentions; uatu's 2.x stack still reads only `command.list`. 2.x also has a native "Reload configuration" operation (`location.reload`, `/reload` in OpenCode's own TUI) that uatu does not offer, so a changed OpenCode config means restarting the workspace (#460).

## What Changes

- **Skills return to the palette on 2.x.** The 2.x command inventory is the union of OpenCode's config commands, its skills (as `kind: "skill"`, the kind 1.x already reports), and uatu's built-ins. `/skill-name args` is dispatched the way OpenCode's own 2.x clients invoke a skill: a prompt carrying the skill as an attachment, with the text `@skill-id args`. The user turn reads as that invocation in the live timeline and after a history reload. A skill that OpenCode no longer knows at dispatch is refused in the conversation, like an invalid command.
- **Skill entries are labelled.** Palette rows of kind `skill` carry a small "skill" label so a skill and a command with similar names are told apart (both generations; 1.x already reports the kind but never showed it). This is the first user-visible piece of #465.
- **`/reload` on 2.x.** A built-in `/reload` command, offered only when the running OpenCode generation backs it (2.x), asks OpenCode to reload its configuration. The conversation shows the reload starting, then its outcome: "Configuration reloaded" or the failure OpenCode reported. Reload is workspace-wide (every conversation served by that OpenCode server), does not interrupt a running turn (OpenCode drains and continues it), and asks for no confirmation.
- **Catalogs follow the reload.** After a successful reload the client that invoked it re-reads the agent's commands (including skills), models, and modes so the picker and palette match the new configuration without a browser refresh. Other open clients re-read the catalogs when they next start a slash query or open the configuration picker; the background refresh now covers modes as well as commands and models.
- **1.x unchanged.** `/reload` is not offered on 1.x (no such operation); skill listing and dispatch on 1.x keep their current path.
- **Out of scope:** a dedicated skills inspector view (#465 beyond the label), `@skill` mention autocomplete in the composer, arguments for OpenCode's argument-less `session.skill` activation route, restarting OpenCode (#384).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: two new requirements — skills are part of the command inventory on every generation, labelled in the palette, and a 2.x skill invocation goes out as a skill-attached prompt; `/reload` reloads OpenCode's configuration on 2.x with a visible outcome and refreshed catalogs. Existing requirements are not modified.

## Impact

- `src/chat/opencode/v2/provider.ts`: `listCommands()` reads `skill.list` alongside `command.list`; `command()` routes a skill name to `session.prompt` with a `skills` attachment, and `reload` to `location.reload()`, reporting both through the existing injected-event path (notice rows + status).
- `src/chat/opencode/v2/normalization.ts`: a user message carrying skill attachments renders its text (already `@skill-id …`), so no new item type; verify replay of a skill turn.
- `src/chat/opencode/sdk-coverage.ts`: `skill.list` and `location.reload` move from "not conversation activity" to covered.
- `src/chat/ui.ts` / `src/styles.css`: the skill label in the palette; after a `/reload` outcome, re-read catalogs for the invoking client; the background refresh also re-reads modes.
- `src/chat/types.ts` / wire: no new item, event, or route. `/reload` rides the existing command route and the existing `notice` item and status updates, so no API revision change.
- Tests: `src/chat/opencode/v2/provider.test.ts` (fake 2.x server routes `GET /api/skill`, `POST /api/location/reload`), `normalization.test.ts`, `slash-commands.test.ts`; no 2.x e2e fake exists, so a real-2.x check is a PR-time step.
- Issues: fixes the missing-skills report, implements #460, and provides the data source and first visible piece for #465.
