## ADDED Requirements

### Requirement: Chat lets the user choose how hard the model reasons
Where the agent declares the reasoning-variant capability, Chat SHALL let the user choose how hard the selected model reasons, from the named ways of thinking that model advertises — such as thinking harder or faster. The choice SHALL be scoped to how a prompt runs, sent with the prompt rather than changing the model, and SHALL be remembered per conversation as the model choice is. A model that advertises no such ways offers no choice, and where the capability is undeclared the control is absent rather than shown empty.

#### Scenario: A model's reasoning variants are offered and sent
- **WHEN** the selected model advertises reasoning variants and the user chooses one
- **THEN** the choice is presented as how the prompt runs, not as a different model
- **AND** the next prompt is sent with that variant
- **AND** the choice is remembered for the conversation

#### Scenario: A model without variants offers no reasoning control
- **WHEN** the selected model advertises no reasoning variants
- **THEN** no reasoning control is shown for it

#### Scenario: An unknown variant is refused
- **WHEN** a prompt is sent with a variant the selected model does not advertise
- **THEN** the server refuses it rather than forwarding it

#### Scenario: The control is absent when the capability is undeclared
- **WHEN** the agent does not declare the reasoning-variant capability
- **THEN** no reasoning control appears
- **AND** the capabilities the agent does declare are unaffected
