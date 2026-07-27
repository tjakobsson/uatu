## ADDED Requirements

### Requirement: Highlight-and-reveal accepts an externally supplied match

The find capability SHALL expose an entry point that reveals and highlights a
match supplied by another feature — identified by document and position rather
than by a query typed into the find bar — using the same highlighting mechanism
as preview find. Callers SHALL NOT implement their own highlighting.

#### Scenario: Revealing a match from project search

- **WHEN** project search asks to reveal a match at a given document position
- **THEN** the match is highlighted and scrolled into view using the preview find highlight mechanism

#### Scenario: Externally revealed match does not open the find bar

- **WHEN** a match is revealed through this entry point
- **THEN** the find bar is not opened and no find query is set

#### Scenario: Requested match no longer exists

- **WHEN** the requested position no longer contains the expected text
- **THEN** no highlight is painted and the preview is not scrolled to an arbitrary position
