## 1. Baseline and captures

- [x] 1.1 Write a throwaway stdio MCP server exposing one tool that takes arguments (kept outside `src/`, under `tests/fixtures/` or a scratch dir), register it in a throwaway workspace's `opencode.json`, and verify OpenCode 1.18.32 and 2.0.18 each list the tool (`opencode` TUI or `/mcp` route).
- [x] 1.2 Drive one prompt per generation on the dev hub that calls the tool and hits the permission; save the raw `permission.asked` / `permission.v2.asked` event and the preceding tool events from each generation into `src/chat/opencode/` test fixtures, and record in `design.md` whether the 1.x event carries `tool.callID` (D1). (Driven through `.local/mcp-capture/capture.ts` against isolated servers rather than the dev hub; 2.0.18 saved as `tests/fixtures/opencode-v2/real-2.0.18.json`. 1.18.32 never exposed the MCP tool to the model in four runs; the 1.x call reference is the 1.18.29 live event already in `v1/normalization.test.ts`. See design.md — Context.)
- [x] 1.3 Capture before screenshots of the pending MCP permission card at desktop (1400x1000) and phone width as `screenshots/before-mcp-permission-desktop.png` and `screenshots/before-mcp-permission-phone.png` under the change folder, and verify the files exist.

## 2. Wire shape and contract

- [x] 2.1 Add optional `sourceToolId: string` to `PermissionRequest` in `src/chat/types.ts` and to `PendingPermission` in `src/chat/provider.ts`, and admit it in `parsePermissionRequest` in `src/chat/validation.ts`; verify `validation.test.ts` accepts an item with the field, an item without it, and rejects an empty string.
- [x] 2.2 Add `sourceToolId` to `PermissionItem` in `api/openapi.yaml`, extend `api/examples/sse/live-conversation-permission.json` (or add a sibling) with a permission carrying it, bump `WORKSPACE_API_REVISION` to 22 in `src/shared/version.ts` and the OpenAPI version / `x-uatu-revisions` / `api/contract.json`, and add a changelog section with a Migration paragraph; verify `bun run test:api` and `bun run api:validate` pass.

## 3. OpenCode carries the call reference

- [x] 3.1 Read `source.id` (when `source.type === "tool"`) and, if 1.2 showed it on the wire, `tool.callID` in `pendingPermissionFields`, emitting `sourceToolId: "tool:<id>"`; verify `normalization.test.ts` covers the 2.x shape, the 1.x shape, a request without either, and that the real 2.0.13 fixture's `permission.asked` yields the id of its `session.tool.called` row.
- [x] 3.2 Keep `sourceToolId` across the reply's sparse upsert in the adapter's permission merge and map it in pending-permission seeding; verify `adapter.test.ts` shows a replied permission still carrying it and a recovered permission carrying it from `listPermissions()`.
- [x] 3.3 Verify `v2/provider.test.ts` covers `listPermissions()` returning the field for a request that names its source, and mark `source` as read in `src/chat/opencode/sdk-coverage.ts`; verify `bun run coverage:agents` reflects it. (The coverage report is per event type, not per field, so there is no `source` entry to mark; `coverage:agents` runs unchanged.)

## 4. The card shows the call

- [x] 4.1 Build the tool-row lookup once per `TimelineRenderer.render()` (by id, plus the newest not-completed row per tool name) and pass the resolved row into `renderItem`/`renderPermission` as part of the cache key (D2); verify `timeline-renderer.test.ts` shows a card re-rendering when its linked row's input changes.
- [x] 4.2 Render the arguments block for a wildcard-only request in `renderPermission` (the linked row's input as a `<pre>` under a lead line, replacing the `*` bullet) while the request is pending only, and leave requests with a specific resource, a diff, or a plan untouched (D3, D5); verify unit tests for: 2.x exact join, name fallback, no row found (today's markup), a bash permission with a running row of the same name (no block), and a resolved card without the block.
- [x] 4.4 Fold a later upsert into the buffered one in `src/chat/coalescer.ts` with the projection's merge passed from the adapter (D8, found in 5.3: a 2.x `session.tool.progress` in the same window as `session.tool.called` left the live row without its input); verify `coalescer.test.ts` shows the fold and `adapter.test.ts` shows a pumped 2.x call keeping its input and publishing it once.
- [x] 4.3 Style the block in `src/styles.css` for desktop and touch mode, reusing the request card's existing `pre` treatment; verify visually in 5.2.

## 6. Name the MCP server and tool (review follow-up, D6/D9)

- [x] 6.1 Add optional `mcp: { server: string; tool: string }` to `PermissionRequest`, `PendingPermission`, the client validator, `PermissionItem` in `api/openapi.yaml` (same revision 22 section of the changelog), and the MCP example; verify `validation.test.ts` accepts it, rejects an empty server, and `bun run test:api` passes.
- [x] 6.2 Add `src/chat/opencode/mcp-tools.ts` with `mcpToolFromAction(action, servers)` (longest sanitized-server prefix, non-empty tool remainder) and a server-name cache that refetches on a miss and drops on `mcp.*` events; verify unit tests for sanitized names, a server whose name contains `_` or `-`, two servers where one is a prefix of the other, and no match.
- [x] 6.3 Annotate pending permission upserts in both providers' `events()` loops and in `listPermissions()` (1.x `mcp.status`, 2.x `mcp.list`); verify `v1/provider.test.ts` and `v2/provider.test.ts` show a live ask and a recovered ask carrying `mcp`, and a built-in action carrying none.
- [x] 6.4 Render `Permission: MCP <server> › <tool>` in the card summary when `mcp` is present, keep the raw action in the Allow-always confirmation, and seed `mcp` in the e2e; verify `timeline-renderer.test.ts`, the e2e, and refreshed screenshots (fixture and real 2.0.18) under the change folder.

## 5. End-to-end and evidence

- [x] 5.1 In `tests/e2e/chat-requests.e2e.ts`, seed a running tool row named `github_create_issue` with JSON input followed by a wildcard permission of the same action carrying `sourceToolId`, and assert the card shows the arguments and no `*` bullet, that answering it resolves the card without the block, and that a bash permission seeded beside it shows no block; verify the test passes in both projects.
- [x] 5.2 Run the suite with `UATU_E2E_SCREENSHOTS_DIR=openspec/changes/show-mcp-permission-arguments/screenshots` and save after screenshots at desktop and phone width for the pending and resolved card; verify the files exist beside the before shots.
- [x] 5.3 Rebuild `dist/uatu`, run the 1.2 prompt again on each real generation, and verify the card shows the call's arguments on 2.x and, via the exact or the fallback join, on 1.x. (2.0.18 verified through the built binary and a scratch hub: `screenshots/real-2.0.18-mcp-permission-desktop.png` and `-resolved-desktop.png`, driven by `.local/mcp-capture/real-run.ts`. This run is what found the coalescer defect, 4.4. 1.18.32 could not be exercised live, see 1.2; the 1.x join rests on the unit tests over the 1.18.29 event.)
