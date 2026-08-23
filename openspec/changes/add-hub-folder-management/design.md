## Context

The Hub currently treats the host filesystem as browsable but not managed. `GET /api/hub/browse` returns lexical absolute paths and immediate non-symlink child directories, workspace registration stores absolute paths under stable ids, session lifecycle operations are serialized per workspace, and clone jobs reserve exact target paths in memory. There is deliberately no configured workspace root; authenticated Hub users already receive shell access as the daemon's OS user, so folder mutation does not introduce a stronger filesystem authorization boundary.

Renaming a directory can affect any number of registered descendants. Filesystem rename, registry persistence, personal-state cleanup, and credential-assignment cleanup span different stores, while session starts and clone creation can race those changes. The implementation therefore needs one coordinated operation rather than independent route handlers that call `fs` directly.

## Goals / Non-Goals

**Goals:**

- Keep filesystem location, stable workspace identity, and durable Hub metadata coherent across folder mutations and Hub restarts.
- Serialize a mutation against every affected session lifecycle and overlapping clone target.
- Preserve the existing trust model and absolute-path browser without introducing a workspace-root configuration.
- Give the bundled page and independent Hub clients explicit, testable conflict responses.

**Non-Goals:**

- Recursive deletion, trash/recovery UI, file management, moves between parents, copying, or uploads.
- Renaming stable workspace ids or session URL prefixes when folder names change.
- Following or mutating a symbolic-link directory entry.
- Per-Hub-user filesystem permissions beyond the daemon OS user's permissions.
- Automatically restarting workspaces after a rename; a confirmed stop leaves them stopped.

## Decisions

### 1. Add a folder-mutation coordinator rather than placing filesystem writes in the router

A focused Hub folder manager will own validation, path relationship checks, path reservations, session coordination, filesystem calls, registry updates, metadata cleanup, and recovery. `server.ts` will parse the authenticated requests and map typed outcomes to HTTP responses, but it will not assemble multi-store transactions itself.

This keeps the correctness boundary independently testable and prevents create, rename, and remove from developing different race behavior. Direct route-local `mkdir`, `rename`, and `rmdir` calls were rejected because they cannot atomically coordinate with starts, clone jobs, and registry persistence.

### 2. Publish three additive POST operations

The public Hub contract will add:

- `POST /api/hub/folders/create` with `{ parent, name }`
- `POST /api/hub/folders/rename` with `{ path, name, stop?: boolean }`
- `POST /api/hub/folders/remove` with `{ path, stop?: boolean }`

Create returns the created absolute path. Rename returns the new absolute path and affected workspace ids. Remove returns the removed path and any removed workspace id. A request that needs active sessions stopped returns `409` with `{ error, needsStop: true, workspaceIds }`; retrying with `stop: true` authorizes the Hub to await starts, stop those sessions, and continue. Other conflicts use ordinary typed error responses.

Separate operations keep each closed request schema simple and give independent clients stable operation ids. Overloading `POST /api/hub/workspaces` was rejected because unregistered folder management is not workspace creation and an action union would weaken that route's contract. The additions are backward compatible, so the Hub API revision remains unchanged unless contract tooling identifies an incompatible change elsewhere.

### 3. Validate a parent plus one visible path segment

Create accepts an absolute parent and rename accepts an absolute source plus a replacement basename. Names are rejected when empty, `.` or `..`, prefixed with `.`, contain NUL, or contain either platform path separator. The coordinator derives destinations itself and never accepts a client-computed destination. It normalizes lexical absolute paths consistently with registration, uses `lstat` for mutation sources, rejects symbolic links, and checks destination nonexistence before `fs.rename`.

Remove uses non-recursive `rmdir`; no precomputed listing is treated as proof of emptiness. This lets the filesystem reject files, hidden entries, and directories added in a race. Rename never relies on platform-specific overwrite behavior: an existing destination is a conflict before the call, and any race is surfaced rather than handled by removal.

Hidden folder creation is excluded because the existing browser intentionally hides dot-directories; allowing one would make a successful action immediately disappear from the managing UI.

### 4. Use one hierarchy-aware path reservation coordinator for clones and folder mutations

Extract clone target reservations behind a shared in-memory path reservation service. A reservation conflicts when either path equals or is an ancestor of the other, using normalized component-aware `path.relative` checks rather than string prefixes. Clone creation reserves its target as it does today. Folder create reserves the child destination; rename reserves source and destination subtrees; remove reserves its source.

Conflict checking and reservation acquisition happen synchronously in one coordinator before asynchronous work begins. This closes the check-then-act race where a clone could start after a folder operation checked `isTargetReserved`. Reservations remain process-local because active clone jobs and session children are themselves process-local.

### 5. Add composite session lifecycle serialization

Extend the session manager with a composite operation over a sorted unique set of workspace ids. Publishing one shared barrier into every affected workspace's lifecycle chain before awaiting predecessors ensures a concurrent start or stop queues entirely before or after the folder mutation without lock-order deadlocks.

Inside the barrier, a request without `stop: true` inspects running and published-start state and returns the complete `workspaceIds` conflict without changing anything. An authorized request waits for predecessors, stops every running result through the backend, clears session credential bookkeeping, performs the folder transaction, and then releases all chains. A start submitted after the barrier reads the committed registry path. The operation does not restart stopped sessions.

Serializing only the exact workspace path was rejected because renaming a parent changes every registered descendant. Globally serializing all workspace lifecycle operations was also rejected because unrelated workspace starts need not block one another.

### 6. Update descendant registrations as one registry mutation

The registry will expose component-aware lookup of entries at or below a path and a serialized bulk path replacement. It computes every new path before changing memory, rejects collisions with unaffected registered paths, writes one atomic registry snapshot, and restores the previous in-memory array if persistence fails. Workspace ids and backend values are copied unchanged, so personal state and credential assignments remain keyed correctly after rename.

Removing an empty registered path reuses the existing forget semantics for personal state and credential assignments, but runs inside the same composite lifecycle and folder transaction. An empty directory cannot contain a registered descendant on disk; an exact registered entry is the only registration removed.

### 7. Journal registered filesystem mutations for crash recovery

Atomic registry files do not make a filesystem rename and registry rewrite atomic together. The folder manager will keep a single versioned pending-operation journal in the Hub state directory because folder mutations are serialized. Before a registered rename or removal crosses its first irreversible boundary, it atomically records source, destination when applicable, affected ids, and old/new registry paths.

For rename, recovery examines source and destination using `lstat`: destination-only means it finishes the new registry mapping; source-only means it restores the old mapping; ambiguous states fail startup with a diagnostic rather than guessing after external filesystem edits. For registered removal, successful `rmdir` commits forward: recovery finishes registry, personal-state, and credential cleanup; if removal never happened, it restores retained metadata. The journal is cleared only after all durable state agrees.

Within a live request, failures trigger best-effort rollback before returning. The journal remains when rollback cannot prove coherence, allowing deterministic startup recovery. Unregistered create, rename, and remove need no journal because each is a single filesystem operation with no Hub metadata to reconcile.

This is more machinery than best-effort rollback, but it preserves the registry's existing crash-safety promise. Accepting a crash window where a stable id silently points to the old missing path was rejected.

### 8. Keep folder controls in the existing Clone-page browser

The currently browsed directory gets a compact new-folder form. Each child row gets Rename and Remove actions in addition to Add/Open. Rename uses a small dialog prefilled with the current name; Remove uses a destructive confirmation that states only empty folders can be removed.

On a `needsStop` conflict, the page presents a second confirmation naming all affected workspace ids and warning that shells will terminate. Confirmation retries the same operation with `stop: true`; cancellation performs no request. Controls use the existing busy/error helpers and reload the listing after success. If the currently browsed folder itself is renamed by another client, a failed refresh falls back to its parent and reports why rather than leaving a blank browser.

## Risks / Trade-offs

- [External processes can mutate paths outside Hub coordination] -> Revalidate source type, destination absence, and emptiness at the filesystem call; journal only states the Hub can prove and fail loudly on ambiguous recovery.
- [Stopping several sessions can partially succeed before a later stop fails] -> Do not mutate the filesystem until every affected stop succeeds; report which stop failed. Already stopped sessions remain stopped because restoring shells is not possible.
- [Component-aware path behavior differs by platform case sensitivity] -> Use Node path semantics and exact registry path conventions already used by the Hub; do not attempt filesystem case-folding inference.
- [A registered removal is uncommon because Git repositories are non-empty] -> Keep it supported for imported or externally emptied workspaces, while relying on `rmdir` as the final safety check.
- [The journal adds startup complexity] -> Keep one bounded, versioned pending record, serialize operations, and cover every recovery state with integration tests.
- [More row actions can crowd narrow layouts] -> Reuse the existing multi-button row pattern and allow actions to wrap rather than introducing a new navigation surface.

## Migration Plan

No existing registry entry changes format. On first startup, absence of the folder-mutation journal means no pending work. Deploy the additive routes, coordinator, UI, and OpenAPI entries together. Rollback is safe when no journal is pending; if a pending record exists, the deploying version must recover and clear it before downgrading because older builds do not understand the journal.
