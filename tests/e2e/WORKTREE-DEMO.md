# Worktree prototype — selected Active groups dashboard

**Mock only; Active groups is selected. UX gate 2.2 remains open.**
Independent lifecycle is approved: main Stop affects only main, and a child can
start while main stays stopped. Parent is the configuration owner, not a required
running session. The user chose “Lets go on A”: Active groups is now the sole
worktree-capable dashboard layout, not a product preference. The discarded layout
and toggle are removed. Scenario controls remain test-only; the selected renderer
is reusable actual dashboard presentation. Legacy no-capability behavior is unchanged.
Compact creation/deletion, focused selector, immutable provenance and editable
branch combobox with explicit fetch remain in place. No real integration is approved.

## Review Active groups

- Local dashboard: <http://127.0.0.1:4788/>
- Example tailnet dashboard: `https://review-host.example.ts.net:8446/`
- Example gallery: `https://review-host.example.ts.net:8447/`

Replace the example hostname with your authorized review host when configuring
the optional proxy; these example URLs are not live reviewer endpoints.

1. Open **Scenario controls · independent checkout lifecycles**, choose **Mixed ·
   main stopped, child running**, and explicitly reset once. Atlas main is stopped,
   its `feature/sidebar` child runs, and Beacon is all stopped.
2. Atlas remains under **Active**. The group heading owns Rename/Configure/
   fork; `main · Main checkout` has its own Start action. Its running child has its
   own Stop. Expand `1 stopped worktree` to see the external child. Expand Beacon
   under **Inactive** to Start or fork. Keyboard Enter/Space toggles disclosures.
3. Start main, return to the dashboard, then Stop main: child keeps running.
   Stop and restart a child while main remains stopped. The group moves to Inactive
   only after its last running checkout stops. Active groups remains selected on
   reload and creation/deletion/start/open round trips. Old layout query links
   canonicalize to the dashboard without resetting or mutating state.
4. Reset to **All stopped**: compact inactive groups are expandable to Start or
   fork. No obsolete Sessions/Workspaces buckets appear on the capable demo.
5. Try initial **Existing branch** list clicks without typing: `fix/navigation`
   (Local) or `origin/feature/search` (Remote) fills the input exactly and enables
   Create, on both dashboard and selector. Creation closes with a confirmation;
   only explicit Open starts/navigates. New stopped children appear in the stopped
   disclosure, not as additional running sessions.

The first four gallery images show mixed and all-stopped states on desktop and
touch. Later lifecycle captures expand stopped rows where needed. Touch is
Chromium emulation, not native device verification. The layout decision is not
final UX approval and authorizes no real integration.

## Run and review

```sh
bun run tests/e2e/worktree-demo-server.ts
```

- Actual workspace frontend: `http://127.0.0.1:4788/s/atlas/`
- Original Hub dashboard renderer: `http://127.0.0.1:4788/`
- Second parent: `/s/beacon/`
- Test-review inventory/recovery/folder safety: visible **SIMULATION · scenarios
  and reset** strip → **Review simulated inventory / recovery / folder safety**.
- Secondary lifecycle pages: `/hub-worktrees`; onboarding: `/clone`.

The host binds loopback. `UATU_WORKTREE_DEMO_PORT` changes its port. An existing
HTTPS proxy can be allowed with `UATU_WORKTREE_DEMO_ORIGIN` set to its exact HTTPS
origin (no path, query, credentials or trailing slash). Host must be preserved;
forwarded headers grant no access. Mutation Origin must match. The option provides
no authentication: proxy access must already be restricted to reviewers. This task
does not configure a proxy or change Tailscale routes. The process shares ephemeral
state among reviewers and retains nothing across restart.

## Desktop screenshot gallery

```sh
bunx playwright test tests/e2e/worktree-gallery.e2e.ts --workers=1
bun run tests/e2e/worktree-gallery-server.ts
```

The captioned gallery is generated in
`test-results/worktree-gallery.e2e.ts-desktop-worktree-review-gallery/index.html`.
Its optional read-only server binds `127.0.0.1:4789`, separate from the live demo.
It snapshots only that fixed directory's index, Markdown index and numbered PNGs
into memory; GET/HEAD only, no directory listing or filesystem fallback. Later
Playwright runs can replace the disk artifacts; an already running server retains
its snapshot until restarted. Set `UATU_WORKTREE_GALLERY_ORIGIN` to an exact HTTPS
origin to allow a separately authorized tailnet-only proxy with preserved Host.
The server provides no authentication; proxy access must remain tailnet-restricted.
Never use Funnel for this review gallery.

## Walkthrough

1. Begin in Atlas, select `NOTES.md`, then inspect **Atlas · Planning** chat and
   the simulated terminal. On touch, use Files to access the workspace selector.
2. The selector groups exact branch names beneath Atlas and Beacon, using explicit
   parent/repository identity. It offers switching and parent forks only: **no
   Details or global worktree button**. Muted `from main`, `from origin/foo` or
   `origin unknown` labels retain immutable provenance without changing names.
3. **Add worktree to Beacon** targets Beacon even while Atlas is active. Its menu
   contains only **New branch / worktree** and **Existing branch**. New creation
   has one Name field and Create/Cancel, based on that parent's simulated HEAD.
4. Existing branch opens cached local/remote refs immediately, without fetching.
   Type `rls` to fuzzy-filter `release`, `origin/release`, `upstream/release`.
   Badges and full refs disambiguate them. Arrows move; Enter or tapping an option
   puts its exact display ref into the input and confirms selection. Enter does
   not submit. **Any edit clears the choice and disables Create** until another
   valid option is picked. Reopening a committed field offers the full list.
   Escape closes the list first; another Escape dismisses. Cancel/reopen clears
   the previous choice. Blur closes the list.
5. The small adjacent icon is labeled/titled **Fetch remote branches**. Explicit
   simulated fetch shows loading and adds `origin/fetched`; valid selections and
   queries survive. Scenarios expose auth failure, network failure and selected
   remote disappearance. Errors remain inline and fetch can be retried. A missing
   selected ref disables Create; no substitute is selected. There is no dashboard
   fetch duplicate and no real remote/credential request.
6. Create `feature/login`: its exact name and fixed sibling path are predetermined,
   e.g. `/demo/workspaces/beacon.worktrees/feature-login`. Sanitized collisions get
   deterministic safe suffixes, never overwrite. Creation leaves it stopped and
    leaves the source context unchanged. Success closes the popup, refreshes lists
    and shows a small **Created feature/login** confirmation. Its explicit **Open**
    starts then opens the independent
   `/s/beacon-created-1/` frontend. Return via picker or browser history: files,
   preview, terminal and conversation selections remain independent.
7. The original dashboard keeps paths, status, credential/shell summaries and
   applicable Open/Start/Stop/Rename/unregister actions. Parent **Configure** edits
   synthetic live-inherited policy; children have no Configure or independent
   naming. There is **no generic Details view**. Owned children have a secondary
   **Delete worktree** action. External/unknown/main rows do not.
 8. **Delete worktree?** identifies **parent display name / branch**, never a full
    path, internal IDs, configuration or ownership/status card. Stopped copy is
    “The worktree’s files will be removed. The Git branch will be kept.” with
    Cancel and destructive **Delete**. Running copy is “Its Uatu terminal and agent
    sessions will stop, then the worktree’s files will be removed. The Git branch
    will be kept.” with Cancel and destructive **Stop and delete**. The button
    explicitly authorizes the Uatu stop; no extra checkbox. Simulation controls
    remain outside. Tracked,
   untracked, ignored, locked, nested and known external activity block removal;
    failed stop retains checkout and registration. A short actionable blocker
    replaces the normal message and deletion cannot proceed; no force or promise
    to stop unknown external apps. Success closes the popup and removes the row;
    active-workspace deletion navigates safely to its parent. **Branches always remain**;
   there is no branch-deletion UI. Remove from Uatu unregisters only and preserves
   checkout, branch and provenance.
9. Use the visible test-review inventory control to exercise discovery, external
   registration, loading/network refresh, missing/replaced paths and folder-rename
   safety. Missing paths have inline explanation and Retry refresh, never silent
   recreation. Creation registration failure offers same-checkout Retry
    registration in a compact originating flow; start failure offers **Retry Open**
    without duplicate creation. There is no Worktree ready or automatic Details/
    inventory popup after any successful creation pathway.

No creation popup contains destination/base/configuration/ownership readouts.
Conflicts offer direct existing-checkout Open/Start/registration, never force/reset.
Source history is explicit fixture history or a creation-time snapshot, not inferred
from upstream, merge-base or a parent's current policy. Surviving branches retain
their recorded history when their checkout is removed and recreated.

## Scenario matrix

| Area | Required review behavior |
| --- | --- |
| Selector/dashboard | Two parent groups, exact child branches, muted truthful provenance, parent-only forks, no Details |
| Compact creation | Name or branch field, fetch icon only for branches, list as needed, Create/Cancel, actionable errors |
| Combobox | Fuzzy filter, exact selected input, selected highlight, edit invalidation, keyboard/touch, empty state, cancel cleanup |
| Fetch | Cached immediate list, explicit loading/success/auth/network, query/valid-ref retention, disappearance invalidation |
| Parent target/policy | Exact selected parent, fixed sibling path, live inherited policy with no child Configure or runtime copying |
| Conflicts | Existing checkout action, safe branch/path collision, no force/reset/duplicate submit |
| Completion/recovery | Popup closes, lists refresh, Created confirmation with explicit Open, source unchanged; compact same-checkout registration retry and stopped child on failed start |
| Discovery | External path/ownership retained, no auto-registration or context switching |
| Missing/replaced | Inline unavailable/identity warning and Retry, no recreation/adoption/fallback |
| Guarded delete | Compact parent/branch identity, exact stopped/running copy, no checkbox/metadata/banner, no phone overflow; blockers and stop failure retain checkout; branch always preserved |
| Unregister/folder safety | Preserve checkout/history; dependency guard, stopping not a rename bypass |
| Context/history | Own files/preview/terminals/conversations restore; delayed responses/events do not leak |
| Reset | Clears scenario contexts and pending events; generation fence prevents old history reviving fixtures |
| Accessibility/layout | Desktop/touch Chromium, keyboard/focus, light/dark and titlebar inset; native behavior untested |
| Isolation | No Git, watchers, PTYs, child runtimes, providers, real credentials, persistence or proxy fallback |

## Verification

```sh
bun run typecheck
bunx tsc --noEmit -p tests/e2e/tsconfig.worktree.json
bun test src/shell/worktree-picker.test.ts tests/e2e/worktree-demo-server.test.ts tests/evidence-discipline.test.ts src/shell/hub-nav.test.ts src/shell/personal-state.test.ts src/shell/live-channel.test.ts src/shared/app-url-discipline.test.ts src/hub/pages.test.ts
bunx playwright test tests/e2e/worktree-layout.e2e.ts tests/e2e/worktree-demo.e2e.ts tests/e2e/worktree-context.e2e.ts --workers=1
git diff --check
```

Revision 1.15 verified 2026-09-17: full/dedicated typechecks passed; **161 targeted
tests, 1188 assertions, zero failures**; **82 desktop/touch browser tests passed in
1.4 minutes** (four workers). Twelve selected-layout regressions cover default
Active groups, safe old-link handling, independent main/child lifecycle,
last-running-checkout classification, keyboard disclosures, create/delete and
reload persistence, and direct initial local/remote branch clicks on both entry
surfaces. The original lifecycle/context/safety matrix and no-capability tests
also pass. OpenSpec validation and diff checks passed. None of this is UX approval.

The revised desktop gallery is run **last**, after the regression suites, because
Playwright replaces `test-results/`. It includes compact create confirmations,
stopped/running deletion and blockers rather than obsolete ready/metadata views.
Set `UATU_WORKTREE_REVIEW_ORIGINS` to comma-separated explicitly authorized mock
origins to append actual served-bundle SPA/dashboard completion, explicit Open,
390 × 844 deletion/stop-failure/dirty and retained-registration screenshots.
That opt-in review resets the ephemeral demo afterwards; it does not modify any
proxy route. The gallery server must then be restarted to replace its memory snapshot.

Reviewer endpoint examples (substitute your configured host):

- Live demo: `http://127.0.0.1:4788/` and
  `https://review-host.example.ts.net:8446/`
- Gallery: `http://127.0.0.1:4789/` and
  `https://review-host.example.ts.net:8447/`

Local/HTTPS dashboard and running-child SPA probes passed with no browser page
errors; wrong-Origin mutation returned 403. The live demo is left in the five-row
mixed-lifecycle scenario: Atlas main is intentionally stopped, so its direct
`/s/atlas/` URL truthfully returns 409 until explicitly started. The running child
is available at `/s/atlas-sidebar/`; the dashboard links above remain the review entry.
Runtime PIDs/logs are reported with the handoff, not durable repository config.

Final gallery test passed in **44.5 seconds** (46.1 seconds total), after the complete browser suite:
**80 screenshots**, including four desktop/touch Active groups scenario images
and 18 images captured against the actual localhost/tailnet demo. The snapshot
was restarted; both origins returned the new 80-image index and fresh Active groups
image URLs (200), POST was refused (405), unknown paths returned 404. Gallery
browser loaded its first Active groups image with zero page errors. Tailscale
services were not changed. No later Playwright suite has replaced the captures.

All paths below are relative to
`test-results/worktree-gallery.e2e.ts-desktop-worktree-review-gallery/`:

- `01-active-groups-desktop-mixed-lifecycle.png` / `02-active-groups-desktop-all-stopped.png` — desktop states.
- `03-active-groups-touch-mixed-lifecycle.png` / `04-active-groups-touch-all-stopped.png` — touch-emulated states.
- `63-served-0-active-groups.png` / `72-served-1-active-groups.png` — actual localhost/tailnet dashboard.
- `73-served-1-spa-created.png` / `74-served-1-explicit-open.png` / `75-served-1-dashboard-created.png` — compact completion and explicit Open.
- `76-served-1-phone-delete-populated.png` / `77-served-1-phone-delete-running.png` — exact stopped/running dialogs.
- `78-served-1-phone-delete-stop-failure.png` / `79-served-1-phone-delete-dirty.png` / `80-served-1-phone-registration-retry.png` — blockers/recovery.

Inspected desktop mixed, touch mixed/all-stopped, inherited-policy and served
phone stopped-deletion screenshots. Dialog bounds checks passed without scrolling.
The first touch scenario captures use actual browser touch
emulation; the served gallery's phone appendix is narrow Chromium viewport coverage,
not native mobile verification.

Evidence uses `tests/e2e/evidence.ts`, normal `test-results/` and attachments in
`playwright-report/index.html`; subsequent runs can replace them. Tests never
hard-code a change evidence folder.

## Limitations / approval boundary

This is frontend behavior against ephemeral fake services, not proof of real Git
atomicity, filesystem safety, ownership journals, crash recovery, credential
authorization, startup/stop fencing, PTY cwd or provider isolation. The host imports
no real Hub server or real workspace backend. Only source/assets are read for
bundling; fixture files, attachments and restoration are in-memory Maps. Unknown
requests fail closed and the existing EventSource is observed, not duplicated.

Browser touch/titlebar emulation is not native macOS/WKWebView/mobile keyboard or
screen-reader verification. No provider transcript import is promised. Search,
Git-diff, auth and PWA integration are not enabled by this fixture. No installed
tools or dependencies were added. **Stop at 2.2 for explicit user UX approval.**
