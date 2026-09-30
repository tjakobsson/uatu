## Why

When OpenCode asks permission to call an MCP tool, the chat card reads `Permission: github_create_issue` over a single bullet, `*`, and offers Allow once / Allow always / Reject. The user is asked to approve a call without seeing what it would do (GitHub #476). The card is faithful to the wire. On both OpenCode generations an MCP tool's permission carries only the tool's registry name, a `*` resource, a `*` save pattern, and empty metadata, nothing about the arguments. A bash permission carries its command in `resources`, an edit permission its diff in `metadata.diff`; an MCP permission carries nothing to show.

The arguments exist, one row up. OpenCode records the tool call, with its input, before it asks permission to run it: on 2.x the `session.tool.called` event precedes `permission.asked`, and the permission's `source` names that call by id. The timeline already holds the row; the card just does not point at it.

## What Changes

- A pending OpenCode permission whose request names no specific resource (a wildcard-only request, as every MCP tool permission is) shows the arguments of the tool call it would allow, where the choices are made. The arguments come from the tool row the permission belongs to, which the card resolves from the conversation it is shown in.
- A permission for an MCP tool names the server and the tool as the user registered them (`Permission: MCP github › create_issue`), resolved by matching OpenCode's `<server>_<tool>` action against the MCP servers it reports; the raw action stays in the Allow-always confirmation, since it is the rule OpenCode installs. The item carries the resolution as `mcp: { server, tool }`.
- The permission item learns which tool call it belongs to (`PermissionItem.sourceToolId`, additive on the wire), filled from OpenCode 2.x's `source` and carried through pending-request recovery, so a card rebuilt after a missed announcement shows the same arguments the live one would have. Where the identifier is not on the wire (1.x, unless its event carries the call), the card falls back to the running tool row that bears the request's action name.
- A resolved card recedes as every permission does: the arguments fall away with the choices, as the diff does, and the call stays readable on its tool row.
- A permission that names specific resources, carries a diff, or carries a plan is unchanged. Claude Code's permission cards are unchanged; that path already puts an MCP tool's arguments on the card as its resource.
- The adapter's event coalescer folds a later upsert into a buffered one for the same item with the projection's merge, instead of replacing it. Found while verifying against a real 2.0.18: its `session.tool.progress` lands inside the same window as `session.tool.called` and carries no input, so the live row never had the arguments the card reads (and, before this change, the row itself showed none). A 2.x tool row now keeps its input on that timing.
- **BREAKING** (workspace API): `PermissionItem` is a closed schema, so the new optional property is workspace API revision 22 under the repository's compatibility policy.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `opencode-chat`: *Users can resolve agent interaction requests in context*: a wildcard-only permission shows the arguments of the call it would allow, sourced from the tool row it belongs to, live and after recovery; the resolved card recedes without them. *Chat serves whichever OpenCode generation the workspace has installed*: normalization carries the 2.x permission's source tool call onto the request.

## Impact

- `src/chat/types.ts`, `src/chat/validation.ts`, `src/chat/provider.ts` (`PendingPermission`): the new optional field and its recovery shape.
- `src/chat/opencode/normalization.ts` (`pendingPermissionFields`): read `source.id` (2.x) and the 1.x call reference if the bridged event carries one; both the live event and the pending list go through this one reader.
- `src/chat/opencode/mcp-tools.ts` (new) and both providers: resolve a permission's action against the reported MCP servers, on live events and on the pending list.
- `src/chat/adapter.ts`: pending-permission seeding maps the field; the permission merge keeps it across a reply's sparse upsert, as it keeps `alwaysPatterns`.
- `src/chat/timeline-renderer.ts`, `src/styles.css`: the arguments block on the card, the tool-row lookup from the projection, the wildcard-only rule.
- `src/chat/coalescer.ts` (`mergeUpsert` option), `src/chat/adapter.ts` (passes `mergeInteraction`): a sparse upsert in the same window keeps what the earlier frame carried.
- `api/openapi.yaml` (`PermissionItem`), `api/contract.json`, `api/CHANGELOG.md`, `api/examples/`, `src/shared/version.ts`: workspace API revision 22 with migration guidance.
- `src/chat/opencode/sdk-coverage.ts`: annotate the permission `source` field as read (`bun run coverage:agents`).
- Tests: `opencode/normalization.test.ts` (both generations, plus the real 2.0.13 fixture), `v2/provider.test.ts` (pending list), `adapter.test.ts`, `validation.test.ts`, `timeline-renderer.test.ts`, `api/contract.test.ts`; e2e `tests/e2e/chat-requests.e2e.ts` with a screenshot under the change folder.
- Verification against a real OpenCode 1.18.32 and 2.0.18 with a stdio MCP server, to settle whether the 1.x event carries the call reference and to see the card in the running app.
