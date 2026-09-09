## Why

"Allow always" on a chat permission card sends the persistent approval the moment it is clicked, and the card never shows what that approval will authorize. The rule OpenCode installs is not the command on the card. For `git status --short` it derives `git status *`, and for some requests a sole `*` that opens the whole permission category. Claude Code installs its own rule strings. A user cannot review that scope before granting it, and a slipped click grants it anyway (GitHub #320).

## What Changes

- Choosing Allow always no longer replies. The card moves into a confirmation step that lists the future-approval patterns the owning agent supplied, in that agent's own syntax and apart from the request's resources, states the approval's lifetime in the agent's own terms, and offers Confirm and Cancel. Only Confirm sends the persistent reply. Cancel and Escape return to the pending prompt without answering it.
- A sole wildcard is stated as the whole permission category being allowed, as OpenCode's own TUI does. A request whose agent reports no reusable pattern says so, instead of implying the displayed command is the scope.
- The agent's future-approval scope rides on the permission item over the wire (`PermissionItem.alwaysPatterns`, additive) and through pending-request recovery, so a card rebuilt after a missed event confirms with the same scope the live one would have.
  - OpenCode: the request's `always` patterns, under both event-naming generations and in the pending list.
  - Claude Code: the session-scoped permission updates the persistent reply forwards, rendered as Claude Code permission rules.
- Allow once, Reject, and agent-provided approval intents (plan approval choices) are unchanged.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `opencode-chat`: *Users can resolve agent interaction requests in context*. Persistent approval is confirmed in a second step that shows OpenCode's future-approval patterns, and the patterns survive pending-request recovery. *Persistent-approval scope copy is the owning agent's*. The confirmation step lists the concrete scope in the owning agent's own terms, with the Confirm/Cancel/Escape contract and the wildcard and no-pattern rules.
- `claude-code-chat`: *Tool permissions are brokered interactively*. The session-scoped approval lists, in Claude Code's rule syntax, exactly the updates the reply will forward, and says that nothing beyond this request is covered when there are none.

## Impact

- `src/chat/types.ts`, `src/chat/validation.ts`, `src/chat/provider.ts` (`PendingPermission`): the new optional field on the permission item and its recovery shape.
- `src/chat/opencode/normalization.ts`, `src/chat/opencode/sdk-v2-provider.ts`: carry `always` from both `permission.asked` and `permission.v2.asked` and from the pending list.
- `src/chat/claude/provider.ts` and `claude/normalization.ts`: derive display rules from the session-scoped suggestions the reply already forwards; carry them in `listPermissions`.
- `src/chat/adapter.ts`: pending-permission seeding maps the field.
- `src/chat/timeline-renderer.ts`, `src/chat/ui.ts`, `src/styles.css`: the confirmation stage, its client-side state, Escape handling, focus placement.
- `api/openapi.yaml` (`PermissionItem`), `api/contract.json`, `api/CHANGELOG.md`, `api/examples/`: workspace API revision 15 (a new property on a closed item schema counts as breaking under the compatibility policy).
- Tests: `opencode/normalization.test.ts`, `sdk-v2-provider.test.ts`, `claude/provider.test.ts`, `adapter.test.ts`, `validation.test.ts`, `timeline-renderer.test.ts`, `api/contract.test.ts`; e2e `tests/e2e/chat-requests.e2e.ts`, `chat-agents.e2e.ts`, and the fake in `tests/e2e/chat-service.ts`.
- Both agents share the renderer, so the confirmation step appears for both.
