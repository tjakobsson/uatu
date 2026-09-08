## Why

The Hub's management pages and persistent workspace tab bar are too dense for comfortable one-handed mobile use. The reviewed mobile design provides a clearer Hub, less intrusive navigation, and faster file browsing, but its prototype-only implementation must not replace the application's existing session, routing, security, or state lifecycles.

## What Changes

- Apply the approved iOS-inspired visual language to touch-oriented Hub pages: grouped settings, readable workspace identity and status, one clear primary workspace action, and compact, accessible task sheets. Keep every existing operation available, including those absent from the mock.
- Use a single mobile Hub navigation surface. Initially it contains Hub and Settings; after an authenticated workspace visit it adds leftmost **Return to [workspace]**, retained while browsing Hub/Settings. Add Workspace is a Hub action rather than a tab. Preserve the real `/`, `/clone`, `/settings`, and `/s/<id>/...` navigation lifecycle, not the mock's retained iframe.
- Replace touch-mode's permanently visible workspace tab bar with an overlay selector and movable edge handle. Keep the same four surface tabs, add a separate Hub action only in a confirmed Hub session, show the selector on entry, and dismiss after seven idle seconds unless interaction/focus or Keep Open prevents it.
- Use an in-place materialize-inspired fade, explicit dismissal, keyboard access, safe-area-aware placement, and high-contrast overlay controls over Terminal. Do not restyle the terminal or other workspace interiors.
- Add persistent Preview-only Back to Files, Previous, and Next controls. Step within the exact root/directory and effective client scope; hide direction arrows for a confirmed single-file directory, distinguish light-gray boundaries from errors, and provide retryable loading/failure states.
- Persist the new navigation placement, auto-hide, and Preview-side preferences locally for the Hub/device, without changing workspace-specific geometry or server-side personal state.
- Preserve desktop presentation, all API contracts, authentication, and background-work semantics. Prototype review findings become regression scenarios, not a mandate to copy prototype code or expand the architecture.

## Capabilities

### New Capabilities

- `preview-file-navigation`: Touch Preview file controls, exact-directory sequencing, single-file/boundary presentation, and index/navigation recovery.

### Modified Capabilities

- `touch-navigation`: Overlay selector, edge-handle interaction, accessible timing and sizing, and preservation of the four existing surfaces and their status signals.
- `hub-dashboard`: Mobile presentation, conditional Return navigation, complete management parity, truthful forms, and recovery without losing in-page drafts.
- `personal-workspace-state`: Explicit client-local exception for the new Hub-wide navigation preferences, without leaking workspace-local geometry or semantic state across clients.
- `hub-service`: Documentation-only reconciliation of the older clone-start-failure scenario with the existing API and runtime, which preserve a configured stopped workspace. No backend behavior change is proposed.

## Impact

Likely areas are `src/hub/pages.ts`, existing Hub client helpers, `src/shell/{tab-bar,hub-nav,history,presentation-storage}.ts`, Preview navigation/selection owners, and shared styles. Public route tables, wire schemas, child processes, provider runtimes, and terminal transports remain unchanged. No runtime UI framework, iframe host, fake service, synthetic DOM-click adapter, or prototype persistence key is introduced.

The selected static visual reference is `design/hub-mobile/refined.html`; `design/hub-mobile/README.md` describes the retained screenshots and historical verification report. The runnable prototype and its temporary files have been removed. These artifacts are UX references only; production acceptance requires tests of the real application and existing APIs, including Chromium and WebKit browser coverage and the contribution-guide validation gates. Physical iPhone testing is not required for this iteration.

Implementation is not authorized by this proposal. All implementation tasks remain unchecked until the user explicitly asks to apply the change.
