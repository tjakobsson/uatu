# preview-scrolling Specification

## Purpose

Define which element actually scrolls the preview for the current layout and UI
mode, and the obligation on every scroll-and-reveal path to target it.

## Requirements
### Requirement: The preview's effective scroll container is resolved per use

The system SHALL resolve, at each use, the element that actually scrolls the
preview for the current layout and UI mode, rather than capturing a scroll
container once at module load. In the desktop layout above the stacked
breakpoint the effective container SHALL be the preview shell. In touch mode and
in the ≤900px stacked desktop layout — where the shell is laid out
`overflow: visible` and the page scrolls instead — the effective container SHALL
be the document's viewport scroller. In split layout the rendered pane, which is
its own scroll container, SHALL remain the effective container for content
inside it. Exactly one resolver SHALL serve every caller, so that no call site
re-derives the rule and none can drift from it.

#### Scenario: Desktop single layout resolves to the preview shell

- **WHEN** the effective scroll container is resolved in desktop mode above the stacked breakpoint
- **THEN** it is the preview shell, matching the element every desktop scroll path already targets

#### Scenario: Touch mode resolves to the viewport scroller

- **WHEN** the effective scroll container is resolved with `data-ui-mode="touch"` on the document element
- **THEN** it is the document's viewport scroller, because the preview shell does not scroll in that mode

#### Scenario: Stacked desktop layout resolves to the viewport scroller

- **WHEN** the effective scroll container is resolved in desktop mode at a viewport of 900px or narrower
- **THEN** it is the document's viewport scroller, because the stacked layout scrolls the page

#### Scenario: A live mode switch is reflected without a reload

- **WHEN** the user switches between touch and desktop mode with a document open
- **THEN** the next resolution returns the newly correct container, and subsequent scrolls act on it

### Requirement: Every reveal-and-scroll path SHALL target the effective scroll container

Every path that scrolls the preview to a position SHALL act on the effective
scroll container, and SHALL have an observable effect in every layout and UI
mode. The paths so bound are: find-bar match navigation, the externally supplied
highlight-and-reveal that project search uses, outline entry jumps, in-page
anchor clicks, the fragment scroll after a cross-document navigation, and the
scroll-to-top on a document switch or on a hash-only back navigation. Reveal
geometry SHALL be computed against the container's visible scrollport rather
than its full content box, so that the "already in view" test and the reveal
offset stay correct when the container is the viewport scroller. A scroll
request that resolves to a non-scrolling element is a defect, not a no-op.

#### Scenario: A search result scrolls to its match in touch mode

- **WHEN** the user activates a Search pane result in touch mode and the matched text is present in the current view
- **THEN** the view scrolls to the match and the match is highlighted, exactly as it is in desktop mode

#### Scenario: Find navigation scrolls in touch mode

- **WHEN** the find bar is open in touch mode with matches below the fold and the user advances to the next match
- **THEN** the view scrolls to bring that match into view and marks it current

#### Scenario: A match already in view is not re-scrolled

- **WHEN** the revealed match is already fully visible within the scrollport
- **THEN** the scroll position does not change

#### Scenario: Opening a document lands at the top in touch mode

- **WHEN** the user picks a different document in touch mode while scrolled part-way down the previous one
- **THEN** the new document is shown from its top rather than at the previous scroll offset

#### Scenario: Hash-only back returns to the top in touch mode

- **WHEN** the user has followed an in-page anchor in touch mode and presses the browser back button to a fragment-less URL
- **THEN** the view scrolls to the top of the same document without reloading it

#### Scenario: Desktop scroll behavior is unchanged

- **WHEN** any of these paths runs in the desktop layout above the stacked breakpoint
- **THEN** it scrolls the preview shell exactly as it did before, with no change in landing position

### Requirement: Sticky-header clearance SHALL apply to the element that scrolls

The top inset that keeps a revealed target clear of the sticky preview header
and its blur-fade falloff SHALL be reserved on whichever element is the
effective scroll container, so that browser-driven scrolling (`scrollIntoView`,
fragment navigation) and the find reveal's own offset math both honour it in
every layout and UI mode. Where a host adds a further inset — the desktop
titlebar inset — the reservation SHALL continue to include it.

#### Scenario: An outline jump clears the sticky header in touch mode

- **WHEN** the user taps an outline entry in touch mode
- **THEN** the heading is scrolled fully into view below the sticky preview header, not underneath it

#### Scenario: An in-page anchor click clears the sticky header in touch mode

- **WHEN** the user taps an in-page anchor in touch mode
- **THEN** the target element is scrolled fully into view below the sticky preview header

#### Scenario: The desktop titlebar inset is still included

- **WHEN** a target is revealed in the desktop host, where the titlebar inset adds to the reservation
- **THEN** the target clears both the titlebar inset and the sticky header, as it did before

### Requirement: Scroll-position observation SHALL subscribe to the effective container's events

A feature that tracks the preview's scroll position SHALL subscribe to the event
target that actually emits scroll events for the effective scroll container.
When that container is the viewport scroller, scroll events are fired at the
document rather than at any element inside it, so an element-bound listener
SHALL NOT be relied on. Subscriptions SHALL be rebuilt when the effective
container changes — on a layout change, on a UI-mode switch, and on a document
remount.

#### Scenario: Active-heading tracking works in touch mode

- **WHEN** the user scrolls a document in touch mode with the outline open
- **THEN** the outline entry for the heading currently in view is highlighted and updates as scrolling continues

#### Scenario: Observation follows a UI-mode switch

- **WHEN** the user switches between touch and desktop mode with the outline open
- **THEN** scroll observation is rebound to the newly effective container and active-heading highlighting keeps working
