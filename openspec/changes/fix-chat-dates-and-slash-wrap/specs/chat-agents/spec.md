## ADDED Requirements

### Requirement: The conversation chooser groups conversations by the day of their last activity
The conversation chooser SHALL file every agent's conversations alike
under a heading for the reader's local calendar day of each conversation's
last activity, as the agent reports it. Headings SHALL appear newest day
first, with conversations newest first within a day. A heading SHALL read
"Today" or "Yesterday" for those days, and otherwise the short weekday and
the ISO date (`YYYY-MM-DD`), such as "Sun 2026-09-20", matching the
timeline's day separators. Days and times SHALL be those of the reader's
time zone; weekday names MAY follow the reader's locale, but dates and times
SHALL NOT. Each entry SHALL show the 24-hour clock time (`HH:MM`,
zero-padded, never AM/PM) of its last activity after its title and, where the workspace offers several agents,
its agent. A last-activity time later than the reader's clock SHALL be read
as now. A conversation whose agent reports no usable time (none, or a
placeholder before the year 2001) SHALL show no time and SHALL be listed
after the dated days, under an "Undated" heading when any other
conversation is dated and without a heading otherwise. When the reader's
local day changes while the chooser is shown, its headings SHALL be
relabelled without waiting for the inventory to change. Grouping SHALL NOT
change which conversation is selected.

#### Scenario: Conversations from different days are grouped
- **WHEN** a workspace holds conversations last active today, yesterday, and three days ago
- **THEN** the chooser shows the headings "Today", "Yesterday", and the short weekday and ISO date of three days ago, such as "Tue 2026-09-22", in that order
- **AND** each conversation is listed under the heading for the day of its last activity

#### Scenario: Both agents' conversations share the days
- **WHEN** an OpenCode conversation and a Claude Code conversation were both last active yesterday
- **THEN** both are listed under the one "Yesterday" heading, newest first
- **AND** each entry still names its agent

#### Scenario: Each entry shows its last-activity time
- **WHEN** a conversation was last active at 09:30 yesterday
- **THEN** its entry shows its title followed by 09:30, such as "Tick · OpenCode · 09:30"

#### Scenario: Entry times are 24-hour in every locale
- **WHEN** the reader's browser locale uses a 12-hour clock and a conversation was last active at 7:43 in the evening
- **THEN** its entry shows 19:43, never "7:43 PM"

#### Scenario: Activity moves a conversation to today
- **WHEN** a conversation listed under "Yesterday" gains new activity
- **THEN** once the inventory reflects it, the conversation is listed first under "Today"
- **AND** a day heading left with no conversations is removed

#### Scenario: A conversation with no usable time is undated
- **WHEN** an agent reports no last-activity time for a conversation while other conversations are dated
- **THEN** that conversation is listed after the dated days under "Undated" with no time shown

#### Scenario: Headings roll over at midnight
- **WHEN** the reader's local day changes while the chooser is shown
- **THEN** the heading that read "Today" reads "Yesterday" without any conversation changing

#### Scenario: The touch layout groups alike
- **WHEN** the chooser is opened in the touch layout
- **THEN** it shows the same day headings and entries as on desktop

### Requirement: Chat times are 24-hour and chat dates are ISO in every locale
Every time the chat surface shows, for every agent — including the usage
readout's "as of" time, the conversation cost's "since" time, a scheduled
wakeup's fire time in the composer, its list and the timeline, the hover
time of a timeline item, and a shell output window's completion time —
SHALL be a 24-hour clock time (`HH:MM`, zero-padded, never AM/PM) in the
reader's time zone, whatever the reader's locale. Where a date is shown
with it, the date SHALL be the ISO date (`YYYY-MM-DD`) after the short
weekday, such as "Sun 2026-09-20 19:43"; only weekday names MAY follow the
reader's locale.

#### Scenario: The usage readout's time is 24-hour
- **WHEN** the reader's browser locale uses a 12-hour clock and the plan usage was read at 7:43 in the evening
- **THEN** the readout states "as of 19:43", never "7:43 PM"

#### Scenario: A scheduled wakeup's fire time is 24-hour
- **WHEN** a wakeup is scheduled to fire at 20:03 today, and another eight days from now at 09:00
- **THEN** the first is stated as "about 20:03" and the second with its weekday and ISO date, such as "about Mon 2026-10-05 09:00"

#### Scenario: A hover time states the date and 24-hour time
- **WHEN** the reader hovers a timeline item created at 19:43 on 20 September 2026
- **THEN** its hover text reads the short weekday, "2026-09-20", and "19:43", such as "Sun 2026-09-20 19:43"
