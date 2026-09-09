## 1. Baseline

- [x] 1.1 Capture before screenshots of a pending OpenCode shell permission card at desktop (1400x1000) and phone width, showing today's one-click `Allow always`; save as `screenshots/before-permission-card-desktop.png` and `screenshots/before-permission-card-phone.png`, and verify the files exist.

## 2. Wire shape and contract

- [x] 2.1 Add optional `alwaysPatterns: string[]` to `PermissionRequest` in `src/chat/types.ts` and to `PendingPermission` in `src/chat/provider.ts`; admit it in `parsePermissionRequest` in `src/chat/validation.ts` (D1); verify `validation.test.ts` accepts an item with the field, an item without it, and rejects a non-string entry.
- [x] 2.2 Add `alwaysPatterns` to `PermissionItem` in `api/openapi.yaml` (and `api/streaming.yaml` if it restates the item), add a permission example carrying it under `api/examples/`, and append an additive entry to the current unreleased section of `api/CHANGELOG.md`; verify `bun test api/` passes and the contract diff reports no breaking change.

## 3. OpenCode carries its patterns

- [x] 3.1 Capture a live `permission.asked` / `permission.v2.asked` pair from OpenCode 1.18 for a shell command with a prefix pattern and add it as a fixture in `src/chat/opencode/normalization.test.ts`; verify the fixture shows which of `always` / `save` each generation carries (D2).
- [x] 3.2 Read `always ?? save` under both event names in `src/chat/opencode/normalization.ts`; verify unit tests that each generation yields `alwaysPatterns`, that a request announced under both carries them once, and that the `replied` upsert merge keeps the ask's patterns.
- [x] 3.3 Carry the same field from `listPermissions()` in `src/chat/opencode/sdk-v2-provider.ts` and map it in the adapter's pending-permission seeding; verify `sdk-v2-provider.test.ts` and `adapter.test.ts` cover a recovered request that carries its patterns.

## 4. Claude Code lists what it forwards

- [x] 4.1 Add `describeSessionScopedUpdates(suggestions)` to `src/chat/claude/normalization.ts`, rendering `addRules`/`replaceRules` allow rules as `Tool(ruleContent)` / `Tool`, `addDirectories` as directory grants, and `setMode` as a mode change, driven by the same filter as `sessionScopedSuggestions` (D3); verify unit tests for each shape, for a `userSettings`-destination rule being omitted, and for a `deny` rule being omitted.
- [x] 4.2 Set `alwaysPatterns` on the pending item in `src/chat/claude/provider.ts` at registration and in `listPermissions()`, and share the filter with `replyPermission`; verify a unit test that the listed strings and the forwarded `updatedPermissions` for one suggestion set agree in count, and that an item with no session-scoped suggestion carries an empty array.

## 5. The confirmation stage

- [x] 5.1 Add a `confirming` set parameter to `TimelineRenderer.render()` and render the confirmation body in `renderPermission()` when the item's id is in it: lead line naming the action, the pattern list as `<code>` entries apart from the resources list, the agent's scope note, and `Confirm` / `Cancel` buttons carrying `data-permission-confirm` / `data-permission-cancel` (D4, D5); verify `timeline-renderer.test.ts` covers the generic pair when absent, the full confirmation when present, the sole-`*` wording, the empty/absent wording, and that a card with `choices` never renders the stage (D8).
- [x] 5.2 In `src/chat/ui.ts`, hold one `confirming` set per timeline (parent and drill-down), route `Allow always` into it instead of `resolvePermission`, send `approved-session` on Confirm, clear on Cancel, and drop ids whose item resolves or stops being the active request (D6); verify a unit test that Cancel produces no API call and Confirm produces exactly one.
- [x] 5.3 Add Escape handling on the timeline `keydown` listener for a focused confirming card, stopping propagation, and move focus to `Cancel` when the stage opens (D7); verify with a unit test that Escape clears the stage without an API call and that the composer's Escape handler does not fire.
- [x] 5.4 Styles for the confirmation body (pattern list, lead line, lifetime sentence) in both desktop and touch mode, reusing `chat-request-actions` for the buttons; verify visually in 7.1.
- [x] 5.5 Confirm the pinned outstanding-requests control shows the same stage for the same item id — found to be a jump pill (`#chat-requests-jump`), not a second card render, so there is no second view to keep in step; the renderer-owned `confirming` set is the single source and D4 is corrected accordingly.

## 6. End-to-end

- [x] 6.1 Extend the fake in `tests/e2e/chat-service.ts` to emit `alwaysPatterns` on permission items and record whether a persistent reply was received; verify the fake's own test passes.
- [x] 6.2 Add e2e scenarios to `tests/e2e/chat-requests.e2e.ts`: Allow always opens the confirmation with the fake's pattern shown apart from the resource and no reply sent; Confirm sends one `approved-session` reply and the card recedes as `Allowed always`; Cancel and Escape return to the pending choices with no reply; sole-`*` wording; no-pattern wording; a request resolved while confirming recedes; Allow once and Reject still reply on one click; verify `bun test:e2e -- chat-requests` passes.
- [x] 6.3 Add an e2e scenario to `tests/e2e/chat-agents.e2e.ts` that a Claude Code-owned card's confirmation lists rules in Claude Code rule syntax under Claude Code's lifetime sentence, and an OpenCode-owned card's lists OpenCode patterns under OpenCode's; verify `bun test:e2e -- chat-agents` passes.
- [x] 6.4 Run the full unit suite and the chat e2e files; verify `bun test` and `bun test:e2e` pass. (Result: 2917 pass; the only 4 failures are `src/hub/credential-context.test.ts` and reproduce identically on `origin/main` in this Hub-managed workspace, the projected-wrapper case CLAUDE.md describes. Chat e2e files pass.)

## 7. Screenshots and review

- [x] 7.1 Capture after screenshots at desktop and phone width: `screenshots/after-confirmation-prefix-desktop.png` (a `git status *` pattern beside `git status --short`), `screenshots/after-confirmation-wildcard-desktop.png`, `screenshots/after-confirmation-no-pattern-desktop.png`, `screenshots/after-confirmation-claude-desktop.png`, `screenshots/after-confirmation-phone.png`; verify the files exist and pair with the before shots.
- [x] 7.2 Review the screenshots against D5's open alternative (moving the scope note into the confirmation only) and record the decision in design.md; verify design.md states the outcome.
