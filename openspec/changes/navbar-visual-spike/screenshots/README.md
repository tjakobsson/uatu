# Navbar Visual Spike

Disposable visual evidence only. These screenshots do not establish product requirements.

## Screenshot Sequence

| # | Screenshot | Click sequence | Captured state |
|---:|---|---|---|
| 1 | [01-default.png](./01-default.png) | Load prototype | Workspace and Preview visible; Follow enabled |
| 2 | [02-chat-opened.png](./02-chat-opened.png) | Chat | Workspace, Preview, and Chat visible; Chat active |
| 3 | [03-preview-hidden.png](./03-preview-hidden.png) | Chat → Preview | Workspace and Chat visible; Preview hidden |
| 4 | [04-terminal-opened.png](./04-terminal-opened.png) | Terminal | Workspace and Preview visible; Terminal open and active |
| 5 | [05-changes-since-base.png](./05-changes-since-base.png) | Changes | Since base active; repository facts show vs main |
| 6 | [06-changes-since-last-commit.png](./06-changes-since-last-commit.png) | Changes → Since last commit | Base evidence remains; Changes anchor shows vs HEAD |
| 7 | [07-workspace-history.png](./07-workspace-history.png) | Workspace panel: History | History shares the active workspace context |
| 8 | [08-settings.png](./08-settings.png) | Settings | Centered Settings modal overlays the workspace |
| 9 | [09-workspace-search.png](./09-workspace-search.png) | Workspace panel: Search | Search shares the active workspace context |
| 10 | [10-workspace-switcher.png](./10-workspace-switcher.png) | Open workspace switcher | Three live fixture worktree sessions remain visible |
| 11 | [11-alternate-worktree.png](./11-alternate-worktree.png) | Switcher → navbar-study | Alternate worktree updates panel and preview identity |
| 12 | [12-no-primary-surface.png](./12-no-primary-surface.png) | Workspace → Preview | All primary surfaces hidden; quiet launcher visible |
| 13 | [13-constrained-default.png](./13-constrained-default.png) | Load prototype at 980 × 720 | Default chrome at constrained desktop width |

## Observations

The statements below describe the captured evidence, not recommendations.

- **All primary surfaces hidden:** Screenshot 12 shows the accepted quiet launcher and revised copy.
- **Workspace panel relationship:** Screenshots 05-07 and 09 place Changes, History, and Search beside Files in one context-scoped region.
- **Comparison lenses:** Screenshots 05 and 06 preserve Since base and Since last commit with current repository facts and anchors; arbitrary commit selection is not modeled.
- **Worktree sessions:** Screenshots 10 and 11 show several visibly open fixture sessions with one displayed at a time. Creation, hosting, persistence, synchronization, and split views remain undefined.
- **Selected versus active:** Screenshots 02 and 04 use the accepted neutral pressed tiles and dots with a stronger monochrome active marker.
- **Settings capacity:** Screenshot 08 shows the accepted centered modal direction.
- **Documentation-only wording:** Scope, persistence, and final wording remain unresolved.

## Review Dispositions

| Reviewed direction | Disposition | Review note |
|---|---|---|
| Permit all primary surfaces to be hidden and show a quiet launcher | **Accepted** | Keep the behavior with the revised “Choose a surface” wording. |
| Use neutral pressed tiles and dots plus a monochrome active marker | **Accepted** | Carry this visual grammar into a later production proposal. |
| Use the centered Settings modal shown in screenshot 08 | **Accepted** | Carry this modal direction into a later production proposal. |
| Place Files, Search, Changes, and History in one Workspace panel | **Still open** | Awaiting review of the revised comparison presentation. |
| Preserve Since base and Since last commit in the unified Changes view | **Accepted** | Carry this segmented comparison presentation into a later production proposal. |
| Keep several worktree sessions open behind a one-at-a-time switcher | **Accepted** | Carry this switcher direction into a later production proposal. |
| Use “Documentation files only” wording and undefined semantics | **Still open** | Reassess wording, scope, and persistence in a later product proposal. |
