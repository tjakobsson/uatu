## ADDED Requirements

### Requirement: Chat navigation remains responsive across agents

Claude Code and OpenCode conversations SHALL use the same responsiveness and loading-feedback behavior. Returning to an already loaded Chat surface SHALL display retained content without waiting for a conversation-list refresh, optional catalogs, or a new transcript request. A required resynchronization SHALL preserve that content with an updating indication until current content is available. Hidden Chat activity MUST NOT prevent interaction with Files, Preview, or Terminal. Returning to Chat SHALL preserve drafts, pending attachments, expanded activity, and the prior reading anchor, or follow the latest output if previously pinned.

#### Scenario: Return while the network is slow
- **WHEN** an already loaded conversation is hidden behind another touch tab and the user returns while inventory reconciliation is delayed
- **THEN** the retained conversation is displayed without waiting for that request
- **AND** the user can interact with it or navigate away

#### Scenario: Output arrives while Chat is hidden
- **WHEN** a selected conversation produces output or requests input while another surface is visible
- **THEN** the visible surface remains interactive and chat attention indicators remain current
- **AND** returning to Chat presents the accumulated state without losing the draft or reading position

#### Scenario: Agent catalogs are delayed
- **WHEN** the user opens a conversation whose optional model, mode, or command catalog is delayed or unavailable
- **THEN** transcript loading and navigation proceed independently
- **AND** dependent controls communicate their own availability without applying another agent's catalog

### Requirement: Slow Chat reads expose their progress and recovery

Opening a conversation, loading older history, and retrying a failed read SHALL acknowledge the action immediately. An operation still pending after 200 milliseconds SHALL expose an accessible loading indication naming the operation. Once shown, a progress indication SHALL remain visible for at least 300 milliseconds unless its surface is dismissed. Feedback MUST NOT shift the reading position, erase retained content during refresh, or clear unrelated agent or connection errors. Reduced-motion users SHALL receive the same state information without continuous animation. Completion SHALL mean that the requested content is available for interaction, not merely that bytes arrived.

Obsolete reads SHALL stop controlling feedback when the user navigates elsewhere. Reads SHALL have finite documented deadlines, with actionable timeout or failure feedback and a read retry. Retrying a read MUST NOT create a conversation, resend a prompt, or repeat another mutation.

#### Scenario: Fast read avoids a progress flash
- **WHEN** a read completes before 200 milliseconds
- **THEN** the action is acknowledged without flashing a progress bar

#### Scenario: Slow read identifies the wait
- **WHEN** a read remains pending past 200 milliseconds
- **THEN** the surface identifies the pending operation and remains navigable

#### Scenario: Older history loads slowly
- **WHEN** an older-history request is delayed
- **THEN** the current timeline remains visible, its position stays stable, and the older-history control communicates loading

#### Scenario: Superseded request completes
- **WHEN** conversation A is loading, the user selects B, and A later completes or fails
- **THEN** A cannot replace B's content or settle B's loading indication

#### Scenario: Read times out
- **WHEN** a selected conversation read exceeds its deadline
- **THEN** loading ends with a timeout explanation and a retry action
- **AND** the draft and retained content are preserved

### Requirement: Long-chat improvements are verified without losing interaction behavior

Responsiveness SHALL be validated with equivalent short and long workloads for both agents, measuring warm surface switching, cold conversation opening, older-history loading, streaming, and resume separately. Validation SHALL distinguish server/read duration from browser presentation duration and record the browser, hardware, workload, and throttling settings. Under the documented controlled profile, warm touch-tab return to retained content SHALL meet a p95 target of 200 milliseconds. Delayed data requests MUST NOT determine that warm-return duration.

Optimized presentation SHALL preserve find over loaded history, copy actions, file links, accessible reading order, answerable requests, and stable scrolling. Completed content MUST NOT be silently dropped to meet the responsiveness target.

#### Scenario: Compare both agents under controlled load
- **WHEN** the same recorded workload and device profile are run against Claude Code and OpenCode
- **THEN** the validation report includes separate before/after timings and the warm-return result for each agent
- **AND** an improvement in one agent does not substitute for validating the other

#### Scenario: Find reaches older loaded content
- **WHEN** the user searches for text in an older loaded message whose presentation was deferred
- **THEN** find can locate and reveal that result in the correct conversation order
- **AND** the result's copy actions and file links remain usable
