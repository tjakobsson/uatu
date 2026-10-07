## Why

Opening a large workspace currently waits for Chokidar's crawl, a second sequential file scan, and two repository snapshots. Ordinary edits and a five-second timer repeat whole-workspace work before the preview can update, making a simple follow-and-refresh behavior expensive and slow.

## What Changes

- Serve the workspace shell while discovery runs, with explicit indexing progress rather than an apparently empty or unavailable workspace.
- Use native recursive directory watching under Bun, with Chokidar for polling and unsupported-platform fallback. One bounded initial walk supplies the index and metadata, followed by path-specific create, change, and delete events. Align exclusions and symlink handling with indexing policy.
- Replace routine whole-tree rescans and whole-corpus change messages with bounded file-update batches. Retain full snapshots for joining clients and recovery.
- Keep the current tree library: content-only edits avoid path reconciliation, while creates and deletes use its incremental methods and permit its internal visible-row recalculation.
- Refresh a changed active file from disk regardless of Follow; with Follow enabled, select the latest eligible changed file. Invalidate all affected preview representations and reject stale asynchronous results.
- Schedule repository information independently from document updates. Remove Git provenance lookups from the critical path of Source and Rendered previews, including their file-facts strip.
- Keep reconciliation for explicit recovery and ignore-policy changes, rather than rescanning every five seconds. Preserve atomic-save handling and bounded progress during continuous writes.
- Preserve current selection, direct links, scope, binary/image handling, search membership, and the single brokered live connection. Correct obsolete Author/Review language in the watch-index spec to refer to the existing Follow capability.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `document-watch-index`: Single discovery pass, incremental index and transport updates, independent repository refreshes, and explicit recovery guarantees.
- `serve-cli-startup`: Usable HTTP readiness before background indexing finishes, while retaining startup validation and the Hub's URL readiness signal.
- `follow-mode`: Discovery does not behave like editing; batch selection and fresh active-file reloads have explicit rules.
- `hub-live-stream`: Deliver document patches to current subscribers and coherent snapshots to joining or resynchronizing subscribers.
- `file-facts`: Filesystem facts accompany fresh content immediately; Git provenance arrives independently and cannot block rendering.

## Impact

- Server: `src/server/watch-session.ts`, roots and ignore policy, refresh scheduling, render dispatch, navigation, document routes, and `src/cli.ts` startup.
- Browser: boot, document event reduction, preview caches/load guards, sidebar reconciliation, search invalidation, and file-facts enrichment.
- Hub and contracts: document-topic snapshot/patch handling, shared state types, workspace API/build compatibility checks, OpenAPI, contract fixtures, and affected desktop consumers if their generated models change.
- Git: repository collection and per-file facts, including shared work across comparison targets and metadata-only changes in linked worktrees.
- Tests: controlled watcher/discovery tests, real filesystem save/recovery cases, Hub replay tests, browser freshness tests, and deterministic large-workspace work counters.
- Keep the existing live transport and Chokidar 5.0.0 fallback dependency. The native observer avoids Bun's expensive per-file watch setup without requiring Node or another process.
