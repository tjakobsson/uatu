## ADDED Requirements

### Requirement: Chat reads at its own density and tiers its surfaces
The Chat surface SHALL set a reading density of its own rather than inheriting the document preview's prose scale, so that a conversation read in a narrow side panel shows several turns at once. That density MUST apply to the whole surface — transcript, rendered assistant Markdown, requests, pinned tracks, and composer — so that no region is left at a scale that disagrees with the rest. The document preview's own reading scale SHALL be unaffected.

Chat SHALL present its pinned progress tracks as a tier distinct from the transcript entries above them, so a reader can tell at a glance which part of the surface reports the present state. That distinction MUST NOT rely on colour alone, and MUST hold under both the light and the dark colour scheme.

#### Scenario: The conversation is denser than the preview
- **WHEN** the same viewport shows the rendered document and the Chat transcript
- **THEN** Chat renders its conversation at a smaller reading scale than the document preview
- **AND** the document preview's own scale is unchanged

#### Scenario: Every chat region shares the scale
- **WHEN** a conversation shows assistant Markdown, an activity row, a request card, a pinned track, and the composer
- **THEN** all of them read at Chat's scale
- **AND** no region reads at the document preview's scale

#### Scenario: Live tracks are distinguishable from the transcript
- **WHEN** a conversation is running with an active task list and running subagents
- **THEN** the pinned tracks are distinguishable from the transcript entries above them
- **AND** the distinction is carried by something other than colour alone

#### Scenario: The tier survives both colour schemes
- **WHEN** the surface is rendered under the light scheme and under the dark scheme
- **THEN** the pinned tracks remain distinguishable from the transcript in both
