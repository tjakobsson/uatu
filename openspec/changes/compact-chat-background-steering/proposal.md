## Why

The current touch chat spends too much conversation space on expanded pending messages, worker tracks, and Continue disclosure. Users also have to separately background blocking work after steering; the requested default-on personal Hub setting should make accepted steer actions continue naturally without changing agent launch policy.

## What Changes

- In touch mode, default to one collapsed pending summary (for example, `2 steers · 1 queued`, omitting redundant totals and zero categories) and one collapsed visible-worker summary (`2 working · 4 finished`); expand for existing details/actions. Dismissed counts are not shown; omit the worker card when all entries are dismissed. Keep replacement/batch warnings and operation uncertainty visible outside collapsed content.
- Compact the touch composer with inline attachment/model/context, distinct Send and Stop, and two-second hold-to-Queue without Options or Send dropdowns. Preserve keyboard shortcuts and described Space-hold access, 44px composer/Stop targets, 8px mutation spacing, keyboard/safe-area budgets, transcript reading anchors and explicit bottom pinning. Workers use one flat active-first list with dense single-line inspection, a small chevron and right-aligned header Dismiss finished; the approved 28px overview density exception does not shrink worker Stop. Dismiss finished stays view-only, without Restore; timeline history/inspection remains.
- Add the compact **Keep workers running when I steer** switch to Hub Settings → Personal chat preferences, with explicit Save and collapsed Learn more. Keep default ON for each Hub account, persisted across restarts and synchronized across its devices/workspaces, never inherited by other users.
- Authenticate request-local personal policy with a separate private Hub↔child secret and required fresh child-instance identity for each spawn, independent of the nullable workspace/terminal credential. Missing bootstrap trust disables automation explicitly without weakening existing access gates.
- Apply the setting to all confirmed steer actions: new composer steers, Queue → Steer, Send now (including paused batch resume), and submitted Undo/revert replacements. Stage/Undo alone, ordinary queued sends, job starts, and delivery-menu selection do not trigger it.
- After confirmed acceptance, make at most one eligible native background-all attempt per action under retained receipts. Explain that eligible shells are included; acknowledge partial/unknown outcomes without losing or resending accepted messages, retrying mutations automatically, or claiming worker completion.
- Standalone has no Hub-account preference and retains explicit Continue/current behavior. Claude/V1 and agents lacking both required capabilities retain their delivery semantics.

## Capabilities

### New Capabilities

None; extend the existing chat and Hub settings capabilities.

### Modified Capabilities

- `opencode-chat`: Compact touch disclosures/composer and acceptance-gated automatic backgrounding for Hub steer actions, with truthful outcomes and preserved admission/queue contracts.
- `hub-dashboard`: Personal, account-scoped chat preference management and synchronization, reachable from the workspace Hub menu.

## Impact

Target seams are `src/chat/{ui,viewport,running-work-disclosure,client,service,adapter,types,validation}.ts`, V2 provider eligibility/acceptance evidence, `src/{index.html,styles.css}`, Hub state/persistence, backend child bootstrap/lifecycle, authenticated server/proxy dispatch, Settings page and `src/shell/hub-nav.ts`. The narrow private policy channel adds no public credential or general authentication redesign. Extend existing unit/integration tests and real-provider scripted E2E/mobile geometry fixtures; align `docs/CHAT.md`, architecture and published API contracts during implementation. No dependency installation or provider upgrade is planned.

This focused change builds on `opencode-v2-steering` and `opencode-v2-background-work`, including the existing uncommitted audit/mobile corrections; it does not rewrite or claim completion of either change. Its explicit Hub steer exception supersedes the earlier background change's blanket no-background-on-Send rule only within this scope. Touch collapsed defaults similarly replace automatic expansion only on touch. Preserve all other requirements/tests and reconcile these narrow exceptions when syncing specs after the prerequisite changes.

### Non-goals

No implementation in this proposal workflow; no project instructions, agent configuration, permissions policy, default-agent changes, automatic queueing, automatic background launches, direct child messaging, stop-all feature, durable mutation journal, real Hub mutation, paid model activity, installation or publication. Existing shared-workspace execution remains collaborative: the initiating user's preference controls their action, not the preferences of other viewers.
