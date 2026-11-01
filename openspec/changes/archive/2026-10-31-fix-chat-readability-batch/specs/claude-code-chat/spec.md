## ADDED Requirements

### Requirement: Usage figures read at their count's scale
A conversation's token usage figures, wherever the chat surface shortens
them for at-a-glance reading, SHALL render with the scale suffix that
matches the count's magnitude — thousands, millions, then billions with a
`B` suffix — so a billion-scale total never reads as thousands of
millions. The exact figure SHALL remain reachable through the breakdown,
title, or expansion that already carries it.

#### Scenario: A billion-scale input total reads in billions
- **WHEN** the usage readout shows a model whose input token total has reached 1,023,700,000
- **THEN** the compact figure reads `1.0B`, not `1023.7M`
- **AND** the exact total remains available through the readout's breakdown or title

#### Scenario: Counts below a billion keep their compact form
- **WHEN** the usage readout shows figures below one billion tokens
- **THEN** they render as before — bare counts, `k` below a million, `M` below a billion

### Requirement: A loaded skill is named where it loads
A tool row for a skill-loading event SHALL name the skill it loads in the
collapsed row, whichever input key the agent's CLI generation names the
skill by — a `skill` key, a `name` key, or an `id` alone. The name SHALL
be stated once in the row, as its subject, and the row's expanded details
and forked-transcript navigation SHALL behave as for any skill row.

#### Scenario: The current Skill tool names the skill by id alone
- **WHEN** a skill-loading event's input carries only an `id` naming the skill
- **THEN** the collapsed row states that skill's name as its subject, not a bare generic label
- **AND** the name appears exactly once in the row, with no duplication through the expanded body

#### Scenario: Older payloads keep their behavior
- **WHEN** the input names the skill by a `skill` or `name` key
- **THEN** the row reads exactly as it did before this change
- **AND** a forked skill still offers its transcript from its row

### Requirement: A multi-select question reads whole and states its selection
A multi-select question the agent asks SHALL be readable whole — its full
prompt visible at narrow and wide viewports, wrapped rather than
truncated — and every option's selected or unselected state SHALL read
distinctly from more than colour alone, at narrow and wide viewports
alike.

#### Scenario: A long multi-select prompt is fully readable
- **WHEN** a multi-select question carries a prompt long enough to reach its container's edge at a narrow viewport
- **THEN** the full prompt remains readable, wrapped rather than cut off

#### Scenario: Selected and unselected options are told apart
- **WHEN** a multi-select question is presented with some options chosen
- **THEN** each chosen option reads as chosen and each unchosen option reads as unchosen, from the row's own presentation, at narrow and wide viewports

### Requirement: The owed-answer line follows the form's outstanding required steps
A multi-question form whose required validation spoke the owed-answer line
onto a surface's status region SHALL keep that line accurate as the form
stands — wherever the reader navigates or submits — and SHALL speak it only
while it is the region's current news. The line SHALL name every outstanding
required step of the form, including when raised or refreshed from the Next
advance gate, never the step last left alone.

#### Scenario: An optional empty step does not retire or rewrite a required step's line
- **WHEN** a required step's Next has raised the owed-answer line, and the reader then presses Next past an optional empty step (or tabs across one)
- **THEN** the line survives into the next step, still naming the required steps that remain outstanding
- **AND** once no required step is outstanding, the line retires

#### Scenario: The advance gate names the whole outstanding set
- **WHEN** the reader presses Next on an empty required step while other required steps — earlier or later — are also unanswered, whether on the form's first gate or after the final validation already listed the full set
- **THEN** the owed-answer line names every outstanding required step of the form, not only the step the advance stopped on
- **AND** repeated presses keep naming that whole set instead of shrinking it to the step just left

#### Scenario: An in-flight answer retires nothing until it succeeds
- **WHEN** an answer has gone out but its api call has not yet come back — or has come back failed, its failure reported on the surface the answer ran from
- **THEN** the raised owed lines stay standing on every surface, still reporting the question's unanswered step
- **AND** only the successful resolution retires them — including a line the same pending request raises while its answer hangs, with the reader free to navigate away and back in between

#### Scenario: A successful rejection retires the line it left behind
- **WHEN** a question is rejected after a required validation error raised the owed-answer line
- **THEN** the successful resolution retires that line along with the form
- **AND** a failed rejection leaves the failure's own status standing, with no owed-line cleanup behind it

#### Scenario: A landing resolution retires only the line its own question raised
- **WHEN** a question's reject or answer is still in flight, and meanwhile another conversation's validation — or a newer question of the same conversation — raises the owed-answer line, and the in-flight resolution then succeeds
- **THEN** the line the newer validation raised stays standing
- **AND** the resolution retires only the lines raised by the exact question request it resolved, with the parent's and the drill-down's timelines sharing the one ownership record, so a reject pressed in a drill-down that has since closed still retires the mirrored line on the surface the retirement's routing ends on

#### Scenario: A resolution retires its raised line on every surface while it is open
- **WHEN** a mirrored question's line was raised on the parent surface, and the answer or reject goes out from the drill-down whose surface stays open (or the reverse), and the resolution succeeds — with no stream event to clear the status itself
- **THEN** the raised line retires on every surface whose record matches — the parent's included, the drill-down's included — whether the drill-down is open or has closed, so closing it never exposes a stale status
- **AND** a line a newer unrelated status has displaced stays standing

#### Scenario: Settling one surface's form leaves the other surface's line standing
- **WHEN** both surfaces carry the mirrored card and the child surface's line stands for the child form's still-empty required step
- **THEN** answering the parent form's controls and navigating within it retires only the parent's own line — the child's valid owed error stays standing

#### Scenario: Navigation on one active form never steals another's line
- **WHEN** two active question forms of two owners share the surface's one status line, one form's validation has raised the line, and the reader tabs across — or presses Next past the optional empty step of — the other form, whose own required step is still empty
- **THEN** the line the first form's validation raised stays standing, unrewritten and unowned by the second form
- **AND** the second form's own failed validation (the Next gate or the final check) may take the line over, after which its own settlements keep refreshing it

#### Scenario: The owed line names steps by the labels the tabs render
- **WHEN** a provider mapping puts the long question text in the header and the short label in the prompt, so each tab renders a distinct short label
- **THEN** the owed-answer line names those same labels through the renderer's shared step-label selection, never a divergent algorithm repeating one long header per step
- **AND** equal-length prompt and header pick the header, a missing header picks the prompt, and a step carrying neither reads "the current question"

#### Scenario: An unrelated status is never spoken over
- **WHEN** the status region holds a newer message an outside owner spoke — an outage, a refusal, a turn failure
- **THEN** the owed-answer settlement leaves it standing, whether the form was advanced, rejected, or answered
