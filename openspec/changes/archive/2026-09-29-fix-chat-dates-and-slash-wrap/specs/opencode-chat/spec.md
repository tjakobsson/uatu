## ADDED Requirements

### Requirement: The conversation timeline marks the day its content happened
For every agent's conversations, the timeline — the main transcript and a
subagent drill-down alike — SHALL place a day separator at the start of
each run of content that happened on one local calendar day of the reader,
including the first day shown. Content with no known time — none
reported, or a placeholder time before the year 2001 — SHALL be treated as
belonging to the day of the content before it and SHALL NOT start a
separator. Content whose reported time is later than the reader's clock
SHALL be treated as happening now, so that no separator names a day after
the reader's current day. A separator SHALL read "Today" or "Yesterday" for those days,
and otherwise the short weekday and the ISO date (`YYYY-MM-DD`), such as
"Sun 2026-09-20"; days SHALL be those of the reader's time zone, and only
the weekday name MAY follow the reader's locale. Replayed or paged-in history SHALL be separated by the same
rule as live content, from the times each agent reports for it. While the
reader scrolls through a day's content, that day's separator SHALL remain
visible at the top of the transcript until the next day's separator
replaces it. Only the pinned separator's label SHALL cover the
transcript: content beside the label SHALL stay visible and reachable by
taps and selection, and at most one day's label SHALL be visible at the top
at a time. Content scrolled to — by prompt navigation, by revealing an
item, or by find — SHALL come to rest below the pinned separator rather
than under it, and a separator that is not pinned SHALL NOT cover any part
of the content before it. Separators SHALL NOT be treated as timeline
items: they SHALL NOT participate in scroll anchoring, activity grouping,
item actions, or find matches.
When the reader's local day changes while a conversation is shown, the
existing separators SHALL be relabelled without waiting for new content.

#### Scenario: Messages on different days are separated
- **WHEN** a conversation has messages from two days ago, yesterday, and today
- **THEN** the timeline shows a separator with the short weekday and ISO date, such as "Wed 2026-09-23", before the first of the oldest day's content
- **AND** a "Yesterday" separator before yesterday's first content
- **AND** a "Today" separator before today's first content

#### Scenario: A single-day conversation from the past states its day
- **WHEN** the reader reopens a conversation whose content all happened on one earlier day
- **THEN** one separator naming that day appears above its first content

#### Scenario: Replayed history is dated
- **WHEN** the reader opens a Claude Code or OpenCode conversation whose history is read back from the agent's stored transcript
- **THEN** its day separators reflect the times the agent recorded for that content, not the time it was read

#### Scenario: The day stays visible while scrolling back
- **WHEN** the reader scrolls up through a long day of content so that its separator has scrolled out of view
- **THEN** that day's separator remains visible at the top of the transcript
- **AND** it is replaced by the earlier day's separator once the reader scrolls past that day's boundary

#### Scenario: Only the day label covers the transcript
- **WHEN** a day's separator is pinned at the top of the transcript while the reader scrolls through that day
- **THEN** the transcript text to the left and right of the label stays visible and can be tapped or selected
- **AND** when the next day's separator reaches the top, only one day's label is visible, never one behind the other

#### Scenario: Separators follow the reader's time zone
- **WHEN** two messages were sent at 23:50 and 00:10 in the reader's time zone
- **THEN** a day separator appears between them, regardless of the agent's or server's time zone

#### Scenario: A time slightly ahead of the reader's clock is today
- **WHEN** it is 23:59 for the reader and a message arrives stamped 00:01 of the next day by an agent whose clock runs ahead
- **THEN** the message appears under the "Today" separator
- **AND** no separator names the next day

#### Scenario: Scrolled-to content is not hidden under the pinned day
- **WHEN** the reader jumps to a prompt, or find reveals a match, inside a day whose separator is pinned at the top of the transcript
- **THEN** the prompt or the match comes to rest below the pinned separator

#### Scenario: Find does not match day separators
- **WHEN** the reader searches the conversation for "Today" or "Yesterday"
- **THEN** only occurrences in the conversation's content are counted, not the separators' labels
- **AND** a separator relabelled at midnight does not change the count of an open search

#### Scenario: Labels roll over at midnight
- **WHEN** a conversation stays open across the reader's local midnight
- **THEN** the separator that read "Today" reads "Yesterday" and the one that read "Yesterday" reads the short weekday and ISO date, without new content arriving

#### Scenario: Separators do not disturb reading position
- **WHEN** a new day's first content arrives while the reader is paused above the end of the timeline
- **THEN** the reader's anchored position is preserved as for any other appended content

### Requirement: Slash-command suggestions show their descriptions in full
Slash-command suggestions, for every agent, SHALL wrap a command's name,
description, and argument hint onto further lines rather than truncating
them, and every suggestion SHALL show its complete description whether or
not it is highlighted. The suggestion list SHALL remain scrollable, SHALL
NOT scroll horizontally in desktop or touch layouts, and SHALL keep the
highlighted suggestion in view as the highlight moves. When a long command
name leaves too little room beside it, the argument hint SHALL move onto
its own line rather than wrapping into a narrow column. An argument hint
SHALL wrap only at its spaces, keeping each space-separated token whole,
unless a single token is wider than the whole suggestion list.

#### Scenario: A long description wraps
- **WHEN** the user types `/code` and the agent offers `/code-review` with a description longer than one line of the suggestion list
- **THEN** the description continues onto further lines instead of ending in an ellipsis on one line

#### Scenario: Every suggestion shows its full description
- **WHEN** the suggestion list shows several commands with multi-line descriptions
- **THEN** each suggestion shows its complete description, highlighted or not

#### Scenario: The highlight stays in view among tall suggestions
- **WHEN** the user moves the highlight with the keyboard past suggestions whose descriptions span several lines
- **THEN** the highlighted suggestion is scrolled into view within the list

#### Scenario: Both agents wrap alike
- **WHEN** a Claude Code conversation and an OpenCode conversation each offer a command with a long description
- **THEN** both suggestion lists wrap that description the same way

#### Scenario: A long name does not squeeze the argument hint
- **WHEN** a narrow touch layout offers a command whose name is nearly as wide as the suggestion list, with an argument hint
- **THEN** the argument hint is shown on its own line at a readable width rather than wrapping one character per line

#### Scenario: An argument hint wraps only at its spaces
- **WHEN** a narrow touch layout offers a command whose argument hint, such as `[path/to/a/long/argument] [--comment]`, does not fit on one line
- **THEN** the hint wraps between its tokens, so `[--comment]` stays whole and no `]` is left on a line of its own
- **AND** only a token wider than the whole suggestion list is broken inside
