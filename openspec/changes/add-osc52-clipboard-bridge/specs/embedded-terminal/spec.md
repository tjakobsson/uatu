# Delta: embedded-terminal — OSC 52 clipboard bridge

## ADDED Requirements

### Requirement: Terminal bridges OSC 52 copy sequences to the host clipboard
Each terminal pane SHALL register an OSC 52 handler on its `xterm.js` parser (`term.parser.registerOscHandler(52, …)`) that decodes application-initiated copy sequences (`ESC ] 52 ; <selection> ; <base64-data> BEL/ST`) arriving from the PTY and writes the decoded text to the system clipboard via `navigator.clipboard.writeText`, subject to the configured clipboard policy. The bridge SHALL be write-only: when the data field is `?` (a clipboard read query), the handler SHALL NOT emit any response sequence and SHALL NOT read the clipboard. The handler SHALL honor the selection parameters `c`, `p`, and `s` (all targeting the single browser clipboard) and SHALL ignore sequences with other selection parameters, invalid base64 data, or a decoded payload larger than 100 KB. `allowProposedApi` SHALL remain `false`.

#### Scenario: TUI select-to-copy reaches the host clipboard
- **WHEN** a program in the terminal (e.g. a mouse-mode TUI reacting to a selection) emits `ESC ] 52 ; c ; <base64 of "hello"> BEL` and the clipboard policy is `notify` or `silent`
- **THEN** `navigator.clipboard.writeText("hello")` is invoked
- **AND** the host clipboard — not any container-local clipboard — receives the text, because the browser executing the write runs on the host

#### Scenario: Clipboard read query is never answered
- **WHEN** a program in the terminal emits `ESC ] 52 ; c ; ? BEL`
- **THEN** no response sequence is written to the PTY
- **AND** `navigator.clipboard.readText` is not invoked

#### Scenario: Oversized payload is dropped and reported
- **WHEN** a program emits an OSC 52 sequence whose decoded payload exceeds 100 KB and the clipboard policy is `notify` or `confirm`
- **THEN** the clipboard is not modified
- **AND** the pane shows feedback that the copy was rejected for size

#### Scenario: Invalid base64 is dropped silently
- **WHEN** a program emits an OSC 52 sequence whose data field is not valid base64 and is not `?`
- **THEN** the clipboard is not modified
- **AND** no toast is shown

#### Scenario: Blocked silent write degrades to a Copy button
- **WHEN** the clipboard policy is `notify` or `silent` and `navigator.clipboard.writeText` rejects (e.g. the browser requires user activation)
- **THEN** the pane shows a persistent toast with a Copy control
- **AND** activating the Copy control writes the pending text to the clipboard from within the click gesture

### Requirement: OSC 52 copies are visible and policy-governed via `.uatu.json`
The `terminal` block of `.uatu.json` SHALL accept an optional `clipboard` key with the values `notify` (default), `confirm`, `silent`, and `off`, validated with the same warn-and-fallback approach as the existing terminal font keys. Under `notify`, an accepted OSC 52 write SHALL show a transient pane-scoped toast reporting that the terminal copied N characters. Under `confirm`, the write SHALL NOT happen automatically; the toast SHALL offer a Copy control and the write SHALL occur only from its activation. Under `silent`, accepted writes SHALL show no toast. Under `off`, the OSC 52 handler SHALL NOT be registered. Rapid successive sequences SHALL coalesce so at most one toast is visible per pane.

#### Scenario: Default policy notifies on copy
- **WHEN** no `terminal.clipboard` key is configured and a valid OSC 52 copy is accepted
- **THEN** the text is written to the clipboard
- **AND** a transient toast in the receiving pane reports the number of characters copied

#### Scenario: Confirm policy requires a user gesture
- **WHEN** `terminal.clipboard` is `confirm` and a valid OSC 52 copy arrives
- **THEN** the clipboard is not modified until the user activates the toast's Copy control
- **AND** activating the control writes the pending text to the clipboard

#### Scenario: Off policy leaves sequences unhandled
- **WHEN** `terminal.clipboard` is `off` and a program emits an OSC 52 sequence
- **THEN** no handler processes the sequence beyond xterm.js's default ignore
- **AND** the clipboard is not modified and no toast is shown

#### Scenario: Invalid policy value warns and falls back
- **WHEN** `.uatu.json` sets `terminal.clipboard` to an unrecognized value
- **THEN** a startup warning is surfaced alongside the existing terminal config warnings
- **AND** the pane behaves as if the policy were `notify`

#### Scenario: Rapid copies coalesce into one toast
- **WHEN** multiple valid OSC 52 sequences arrive in quick succession under the `notify` policy
- **THEN** at most one toast is visible in the pane, reflecting the most recent copy
