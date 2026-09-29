## ADDED Requirements

### Requirement: A rate-limit reset names its day when it is not today
Wherever the conversation states when a rate-limit standing resets — the
composer's plan summary, the standing line in the readout it opens, and the
announcement made to assistive technology — the reset SHALL be stated as a
24-hour clock time (`HH:MM`, zero-padded, never AM/PM, whatever the
reader's locale) in the reader's time zone, and SHALL name its weekday
whenever the reset does not fall on the reader's current local calendar
day, however far out it is. A reset on the reader's current local day
SHALL be stated as the clock time alone. The readout's standing line and
the announcement SHALL also state the time remaining until the reset,
phrased as the readout's plan windows phrase it. The plan windows' own
reset times SHALL follow the same day rule, so that no reset on a later
day is ever shown as a bare clock time that reads as today. A reset stated
in a notice kept in the conversation timeline SHALL be stated by its
weekday and 24-hour clock time, whatever day it is read, and SHALL NOT
state a time remaining, so that it stays true when read or replayed later.

#### Scenario: A reset later today is a bare time
- **WHEN** a rate-limit warning stands whose reset falls later on the reader's current local day at 23:00
- **THEN** the readout's standing line states that it resets at 23:00 without naming a day, such as "Resets 23:00 · in 3h 00m"
- **AND** it states the time remaining until the reset

#### Scenario: A reset on another day names the weekday
- **WHEN** it is Monday and a 7-day rate-limit warning stands whose reset falls on Thursday at 23:00
- **THEN** the readout's standing line states that it resets on Thursday at 23:00, such as "Resets Thu 23:00 · in 3d 4h"
- **AND** it states the time remaining until the reset in days and hours
- **AND** the composer's plan summary names Thursday with the reset time, such as "resets Thu 23:00"

#### Scenario: A reset early tomorrow is not read as today
- **WHEN** it is 23:30 and a rate-limit warning stands whose reset falls at 06:00 the next local day
- **THEN** every statement of that reset names the next day's weekday rather than stating 06:00 alone

#### Scenario: A reset a week or more out names only its weekday
- **WHEN** a rate-limit standing's reset falls seven or more local days after the reader's current day
- **THEN** the reset is stated with its weekday and 24-hour time and no date, such as "Resets Mon 23:00 · in 10d 4h"

#### Scenario: Reset times are 24-hour in every locale
- **WHEN** the reader's browser locale uses a 12-hour clock and a reset falls at 7:43 in the evening
- **THEN** every statement of that reset states 19:43, never "7:43 PM"

#### Scenario: Plan windows follow the same day rule
- **WHEN** the readout lists a plan window whose reset falls on the next local day, less than 24 hours away
- **THEN** that window's reset names the day rather than stating the clock time alone

#### Scenario: The announcement carries the day
- **WHEN** a rate-limit standing whose reset falls on a later local day begins or changes level
- **THEN** the announcement made to assistive technology names the reset's day, clock time, and the time remaining

#### Scenario: A timeline notice's reset stays true later
- **WHEN** the timeline shows a notice whose reset was stated earlier, and the reader reads or replays it after that reset has passed
- **THEN** the notice states the reset's weekday and clock time, such as "Resets Mon 23:00"
- **AND** it does not state a time remaining, such as "now" or "in 2h 05m"
