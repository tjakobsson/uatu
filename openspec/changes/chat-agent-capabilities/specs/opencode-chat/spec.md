## ADDED Requirements

### Requirement: Chat surfaces an agent's model options and usage
Where the agent declares the capability behind each, Chat SHALL let the user choose how hard the selected model reasons, SHALL report how full the conversation's context window is, and SHALL attribute each subagent with the model it ran and the tokens it consumed. Each of these SHALL be gated on its own declared capability: an undeclared capability leaves its control or figure absent rather than shown empty, inert, or in error, and its absence SHALL NOT degrade the others.

A reasoning choice SHALL offer the named ways of thinking the selected model advertises — such as thinking harder or faster — and SHALL be scoped to how a prompt runs, sent with the prompt rather than changing the model. It SHALL be remembered per conversation, as the model choice is. A model that advertises no such ways offers no choice.

The context-window report SHALL express how much of the selected model's context the conversation currently occupies, against that model's limit, and SHALL be legible without the user opening anything. It MAY be expandable to the breakdown the agent reports — input, cache, and output — but the collapsed form MUST convey the fill on its own. It reports the live window, not lifetime spend.

A subagent's attribution SHALL reflect the subagent's own session — a subagent may run a different model from its parent — and SHALL state the tokens that subagent consumed. When the agent has not yet reported usage for a subagent, or does not report it at all, the row SHALL stay readable and SHALL NOT assert a figure it does not have.

#### Scenario: A model's reasoning variants are offered and sent
- **WHEN** the selected model advertises reasoning variants and the user chooses one
- **THEN** the choice is presented as how the prompt runs, not as a different model
- **AND** the next prompt is sent with that variant
- **AND** the choice is remembered for the conversation

#### Scenario: A model without variants offers no reasoning control
- **WHEN** the selected model advertises no reasoning variants
- **THEN** no reasoning control is shown for it

#### Scenario: The context indicator reads without being opened
- **WHEN** a conversation has exchanged turns and the agent declares context reporting
- **THEN** the surface shows how full the context window is against the model's limit
- **AND** the fill is legible without expanding anything

#### Scenario: The context breakdown expands
- **WHEN** the user opens the context indicator
- **THEN** it shows the input, cache, and output the agent reported

#### Scenario: A subagent row names its model and tokens
- **WHEN** a subagent has run and the agent reports its model and token counts
- **THEN** its row states which model it ran and how many tokens it consumed

#### Scenario: A subagent without reported usage stays readable
- **WHEN** a subagent has not yet reported usage, or the agent does not report it
- **THEN** the row still names the subagent and its status
- **AND** no token figure is asserted for it

#### Scenario: An undeclared usage capability leaves nothing behind
- **WHEN** the agent does not declare the reasoning-variant or context capability
- **THEN** the corresponding control or figure is absent from the surface
- **AND** the capabilities the agent does declare are unaffected
