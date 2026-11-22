## ADDED Requirements

### Requirement: Chat Find pauses timeline catch-up when revealing a match

Chat Find range reveals on coordinated parent and child timelines SHALL route through the timeline's `CoordinatedScrollOwner` so active or pending smooth catch-up stops and following pauses at the revealed match. Already-visible matches revealed while settled at the bottom with no catch-up SHALL preserve following.

#### Scenario: Find Next reveals a match below the viewport during smooth catch-up
- **GIVEN** a parent or child chat timeline is smoothly catching up to newer output while focus stays in the Find bar
- **WHEN** Find or Find Next reveals a match below the viewport
- **THEN** active catch-up stops immediately and following pauses with the match inside the viewport
- **AND** subsequent streamed output preserves the revealed match position instead of scrolling it out of view

#### Scenario: Find reveals an already-visible match during active catch-up
- **GIVEN** a coordinated chat timeline has an in-flight or pending smooth catch-up animation
- **WHEN** Find reveals a match that is currently inside the viewport
- **THEN** active catch-up stops and following pauses at the current position so the animation does not scroll the match away

#### Scenario: Find reveal landing inside the near-bottom band does not re-pin on scroll echo
- **GIVEN** a coordinated chat timeline reveals a Find match whose landed position falls within 48 CSS pixels of the bottom
- **WHEN** the browser delivers the asynchronous scroll event for that reveal
- **THEN** following remains paused at the revealed match
- **AND** a subsequent deliberate manual downward scroll to the bottom resumes following

#### Scenario: Find reveals an already-visible match while settled at the bottom
- **GIVEN** a coordinated chat timeline is following and settled at the bottom with no active or pending catch-up
- **WHEN** Find highlights a match that is already inside the viewport
- **THEN** following remains active without scrolling
