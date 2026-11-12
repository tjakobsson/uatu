## Why

[Issue #381](https://github.com/tjakobsson/uatu/issues/381) reports stuttering and unexpected jumps while reading mobile conversations across streaming, shell output and changing UI states. PR #633 already contains scrolling changes but lacks the associated OpenSpec planning record; this change documents that work retrospectively and plans the explicitly requested restoration of 48px near-bottom follow resumption.

## What Changes

- Record the existing preservation of paused reading through sends, streaming, Markdown growth, resize and parent/child navigation.
- Record coordinated smooth following with reduced-motion support, immediate upward-input cancellation, independent shell scrolling, legitimate focus navigation and native elastic/subpixel settling.
- Record bounded ordinary history-row geometry lookup with a conservative fallback, normal layout for loaded assistant prose while retaining activity/closed-tool deferral, and cancellable next-frame initial placement that carries pending intent across snapshot replacement.
- Record the larger compact-desktop conversation reserve without changing touch allocation or control floors.
- Restore parent/child timeline resumption when deliberate reader movement returns within 48 CSS pixels of the bottom, or on Latest. Upward input still pauses immediately; resize clamps and programmatic echoes must not resume paused following. Independent shell policy remains unchanged.
- Preserve reading through paragraph append plus rewrap, fractional downward arrival, diagonal shell horizontal progress, and input between snapshot install and first render. Targeted reproductions confirmed these defects during implementation; final integration/browser verification remains tracked in `tasks.md`.
- Keep regression budgets and final verification explicit rather than treating existing source or screenshots as passing evidence.

This is a retrospective record, not evidence that planning or approval occurred before implementation. It cannot retroactively satisfy a before-implementation process requirement. No tests or builds are executed in this planning pass, and no prior test result is certified here.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: stable conversation and shell reading, send behavior, smooth follow and loaded-text layout, parent/child restoration, 48px timeline resumption, and compact-desktop expanded-work reading space.

## Impact

Existing implementation: `src/chat/anchor.ts`, `coordinated-scroll.ts`, `scroll-geometry.ts`, `scroll-motion.ts`, `ui.ts`, `shell-output.ts`, `work-budget.ts`, and `src/styles.css`, with colocated unit tests and focused chat E2E suites. Existing documentation changes include `ARCHITECTURE.md` and `openspec/specs/opencode-chat/spec.md`.

This planning pass writes only `openspec/changes/fix-chat-scrolling/`. It changes no product code, tests, main specs, architecture, screenshots, Git state, dependencies, credentials or deployment. A later authorized implementation pass must reconcile the main spec's current actual-bottom wording with the required 48px policy, verify the final source, and arrange spec sync/archive only after acceptance. No transport/API or dependency changes are proposed.
