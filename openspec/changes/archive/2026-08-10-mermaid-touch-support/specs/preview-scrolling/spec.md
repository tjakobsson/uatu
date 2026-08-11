## ADDED Requirements

### Requirement: Viewport observation SHALL express the effective container in the observing API's own terms

A feature that observes whether preview content is at or near the visible
region SHALL obtain the effective scroll container from the single shared
resolver and translate it into the form its observation API requires, rather
than deriving a container of its own. Deriving one by asking whether an element
has a scrolling overflow value is specifically forbidden: an element can carry
such a value while the viewport is what actually scrolls, and the resulting box
tracks the document rather than the visible region. Where the API distinguishes
an element root from the implicit viewport root, the viewport scroller SHALL be
expressed as the implicit root and never as an element — neither the document
element nor the body element, whose boxes are pinned to the document origin and
so cease to describe the visible region as soon as the page is scrolled.
Passing either clips content permanently out of the observed region rather than
deferring it, so content below the first screenful is never reported and never
acted on. Where such an API fixes its root when observation begins, observation
SHALL be re-established whenever the effective container changes — on a UI-mode
switch in particular — and re-establishing it SHALL be limited to content that
has not yet been acted on, so work already completed is not repeated.

#### Scenario: Page-scrolling layouts observe against the visible region

- **WHEN** viewport observation is set up in a layout where the page scrolls rather than an element — touch mode or the ≤900px stacked layout
- **THEN** the observation uses the implicit viewport root
- **AND** content far outside the visible region is not reported as visible
- **AND** that content is reported as visible once the page is scrolled to it, at any distance down the document

#### Scenario: Element-scrolling layouts observe against the scrolling element

- **WHEN** viewport observation is set up in the desktop layout, where the preview shell scrolls, or in split layout, where the rendered pane scrolls
- **THEN** the observation uses that element as its root
- **AND** an ahead-of-viewport margin expands the region that element clips, rather than being inert

#### Scenario: Observation is re-established after a UI-mode switch

- **WHEN** the user switches between touch and desktop mode while content is still being observed
- **THEN** observation is rebuilt against the newly effective container
- **AND** only content not yet acted on is re-observed

#### Scenario: One resolver serves scroll-position and observation callers alike

- **WHEN** a new caller needs to know what the preview scrolls against, for any purpose
- **THEN** it obtains the answer from the shared resolver rather than inspecting computed styles itself
- **AND** a layout that hands scrolling to a different element requires no change at that call site
