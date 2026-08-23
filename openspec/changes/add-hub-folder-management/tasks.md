## 1. Path And Registry Coordination

- [x] 1.1 Add component-aware normalized path relationship helpers and a shared hierarchy-aware reservation coordinator, with tests for equal, ancestor, sibling, separator, and release cases.
- [x] 1.2 Refactor clone jobs to acquire and release clone targets through the shared reservation coordinator, preserving ownership, cancellation, timeout, and cleanup behavior.
- [x] 1.3 Extend the workspace registry with affected-descendant lookup and one serialized atomic bulk path replacement that preserves ids/backends, rejects collisions, and rolls memory back on save failure.
- [x] 1.4 Add registry tests for exact and nested renames, similarly prefixed siblings, path collisions, concurrent mutations, persistence failure, and stable ids after reload.

## 2. Session Lifecycle Coordination

- [x] 2.1 Add a composite session lifecycle barrier for a sorted set of workspace ids so concurrent starts/stops run wholly before or after one folder operation without deadlock.
- [x] 2.2 Add the authorized stop-all path inside the composite barrier, including in-flight starts, shell termination, credential bookkeeping cleanup, complete needs-stop reporting, and no automatic restart.
- [x] 2.3 Test multi-workspace stop conflicts, confirmed stopping, partial stop failure before filesystem mutation, and starts queued during a registered path update.

## 3. Folder Mutation Service

- [x] 3.1 Implement the folder manager's closed request validation and typed errors for absolute paths, visible single-segment names, direct non-symlink directories, destination collisions, permissions, and non-recursive empty removal.
- [x] 3.2 Implement unregistered create, sibling rename, and empty removal under shared path reservations, with focused filesystem and race tests.
- [x] 3.3 Add the versioned atomic pending-mutation journal under the Hub state directory and wire its initialization and recovery into Hub startup.
- [x] 3.4 Implement registered rename across all affected descendants using the reservation, composite session, journal, filesystem rename, and atomic registry update sequence, with live rollback on failures.
- [x] 3.5 Implement empty registered-folder removal using the same coordination and journal while removing registry, personal-state, and credential-assignment records.
- [x] 3.6 Test registered rename/removal success, stop authorization, metadata preservation/cleanup, clone hierarchy conflicts, injected persistence failures, every journal recovery state, and ambiguous recovery diagnostics.

## 4. Hub API

- [x] 4.1 Wire the folder manager into Hub construction and add authenticated same-origin POST handlers for `/api/hub/folders/create`, `/api/hub/folders/rename`, and `/api/hub/folders/remove`.
- [x] 4.2 Return closed success payloads and typed 400/404/409/500 errors, including `needsStop` and the complete affected workspace id list, without exposing more host filesystem data than the existing browser.
- [x] 4.3 Add integration coverage for authentication, CSRF rejection, validation, create/rename/remove, destination conflicts, non-empty and hidden-entry removal, registered descendants, running and starting sessions, and clone races.

## 5. Directory Browser UX

- [x] 5.1 Add a compact new-folder form to the Clone-page directory browser with busy state, local errors, and refresh-on-success behavior.
- [x] 5.2 Add accessible Rename and Remove controls to directory rows, including a prefilled rename dialog, destructive empty-removal confirmation, responsive wrapping, and actionable filesystem errors.
- [x] 5.3 Handle `needsStop` by confirming the named workspaces and shell termination, retrying with `stop: true`, keeping controls busy through completion, and making cancellation mutation-free.
- [x] 5.4 Preserve browser navigation after mutations, refresh dashboard workspace paths, and fall back to the parent with an explanation if another client renamed the currently browsed path.
- [x] 5.5 Extend page tests for rendered controls, request payloads, stop-and-retry behavior, busy/error states, and narrow-layout markup.

## 6. Public Contract And Verification

- [x] 6.1 Add the three folder operations, closed request/response schemas, stop-conflict shape, examples, and error responses to `api/openapi.yaml`, contract operation inventory, and route coverage.
- [x] 6.2 Run the API contract compatibility checks and keep the Hub API revision unchanged only if the additions are confirmed non-breaking; otherwise apply the required revision and changelog migration updates.
- [x] 6.3 Run focused Hub unit and integration tests, `bun test`, `bun run build`, and `openspec validate add-hub-folder-management --strict`, fixing any failures.
