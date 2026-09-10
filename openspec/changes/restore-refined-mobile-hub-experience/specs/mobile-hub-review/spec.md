## Purpose

Provide an isolated, interactive review of the intended shipping mobile frontend against synthetic backend behavior, with reference-fidelity evidence and an explicit user gate before live integration.

## ADDED Requirements

### Requirement: Review uses the intended shipping frontend
The review environment SHALL render the same reusable frontend intended for live integration, including the current Files, Preview, Chat, and Terminal clients. Synthetic behavior SHALL replace backend responses, not frontend screens, event owners, or state transitions. Fictional content, operation doubles, and scenario controls MUST NOT be included in production modules or production bundles. Screenshots, an iframe, a second fake terminal, or a parallel mock-only Hub UI MUST NOT substitute for the frontend being approved.

#### Scenario: Frontend survives backend replacement
- **WHEN** the review frontend performs a workspace, Settings, or navigation interaction
- **THEN** the frontend's own event and state owners handle it using the supplied backend interface
- **AND** later live integration does not require replacing the approved views with another implementation

#### Scenario: Real surface clients receive synthetic work
- **WHEN** a reviewer opens Chat or Terminal and a synthetic stream produces output
- **THEN** the existing client renders that output and maintains its own scroll, draft, and attention behavior
- **AND** no provider inference or executable shell is started

### Requirement: Mock operations cannot reach live resources
The review environment SHALL be separately launched, visibly identified as simulated, and isolated from existing Hub configuration, sessions, workspaces, credentials, and server processes. Backend operations SHALL act only on synthetic test-owned state. Unexpected requests or transports SHALL fail closed with a diagnosable error, never fall through to a live backend. Scenario reset SHALL clear only review state. Review actions MUST NOT read personal secrets, run credential tools, probe real repositories, clone, mutate workspace files, or create real PTYs.

#### Scenario: Synthetic destructive action
- **WHEN** a reviewer confirms Stop, Forget, credential deletion, device revoke, or folder removal
- **THEN** only the selected synthetic scenario changes
- **AND** existing live Hub sessions and the real filesystem remain unchanged

#### Scenario: Unimplemented request
- **WHEN** a frontend request has no mock handler
- **THEN** the harness reports the missing contract and rejects the request
- **AND** it does not proxy to a real Hub or silently report success

### Requirement: Review covers complete flows and deterministic exceptional states
The review SHALL provide the screen/state inventory in the change's `screen-map.md`, distinguishing directly pictured states from design extensions. Scenario selection SHALL support representative identities, running/stopped/empty states, branch variants, credential capabilities, pending operations, failures, recovery, and synthetic stream progression. Review-only controls SHALL remain separate from product Settings and SHALL not distort the product viewport used for visual comparisons. All sensitive-input examples SHALL use disposable test data with masking and clearing behavior; the review SHALL warn against entering real credentials.

#### Scenario: Reviewer inspects an unpictured flow
- **WHEN** the reviewer chooses a credential type or onboarding outcome not pictured in the reference
- **THEN** the actual frontend presents a coherent extension of the reference's grouped detail and task-sheet patterns
- **AND** the handoff identifies it as requiring review rather than previously approved design

#### Scenario: Review a delayed failure
- **WHEN** a configured operation remains pending and then fails
- **THEN** its control, contextual error, retry/cancel behavior, and retained non-secret form state are observable
- **AND** the simulation does not bypass the actual frontend submission path

### Requirement: Visual evidence is compared rather than merely captured
The review SHALL compare named frontend states with the corresponding refined reference images, normalizing CSS viewport, image scale, theme, and font readiness. Approved branding differences, dynamic fixture content, unchanged workspace interiors, and accessibility adaptations SHALL be identified explicitly. Visual evidence SHALL include composition, typography, icons, spacing, materials, and task transitions, not only overflow or element existence. Deterministic frontend captures SHALL have regression comparisons; expected images MUST NOT be updated simply to make a mismatch pass.

#### Scenario: Structurally wrong but functional navigation
- **WHEN** Hub and Settings links work but lack the reference's icons and label hierarchy
- **THEN** reference-fidelity acceptance fails even if functional tests pass

#### Scenario: Fixture text differs
- **WHEN** a deterministic review workspace has a different name or path from the archived screenshot
- **THEN** the comparison records the text substitution without treating it as permission to change row composition or hide layout differences

### Requirement: Explicit review approval gates live integration
The frontend-first stage SHALL end with a reachable review URL, scenario instructions, evidence, known gaps, and a request for explicit user visual and interaction approval. Passing automated tests or completing the implementation task list MUST NOT constitute that approval. Live backend integration, real branch acquisition, public API publication, and rollout into the live Hub SHALL remain deferred until separately authorized after review. The approval record SHALL distinguish the frontend version and accepted exceptions from later backend verification.

#### Scenario: Tests pass but user has not approved
- **WHEN** frontend checks pass and the review URL is available
- **THEN** work stops at the review gate
- **AND** no real backend implementation begins automatically

#### Scenario: Reviewer requests changes
- **WHEN** the user rejects a visual state or interaction
- **THEN** the frontend is corrected and re-presented against the same reference contract
- **AND** the rejected result is not accepted as a new baseline merely because it was implemented
