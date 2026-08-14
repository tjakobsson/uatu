## ADDED Requirements

### Requirement: Workflows do not check out event-derived refs under privileged triggers
The repository SHALL NOT define a GitHub Actions workflow that checks out a Git ref taken from event payload data — such as `github.event.workflow_run.head_sha`, `github.event.workflow_run.head_branch`, or `github.event.pull_request.head.sha` — under the `workflow_run` or `pull_request_target` triggers. Work that needs elevated permissions after another workflow's validation MUST instead run as a job inside the workflow that produced the validation, or on a trusted trigger that checks out a fixed ref. Job-level `if` guards on the originating repository or branch are not a substitute: they are invisible to external supply-chain analysis, so a guarded checkout still reports as an untrusted code checkout.

#### Scenario: Automation needs elevated permissions after validation
- **WHEN** a workflow needs `pages: write`, `contents: write`, or another write scope to act on validated output
- **THEN** it runs on a trusted trigger such as `push`, `release`, or `workflow_dispatch`, or as a gated job within the validating workflow
- **AND** its checkout resolves a fixed ref rather than one read from the event payload

#### Scenario: Supply-chain analysis measures dangerous workflow patterns
- **WHEN** OpenSSF Scorecard analyses the repository's workflows
- **THEN** its `Dangerous-Workflow` check reports no untrusted code checkout finding

#### Scenario: A reintroduced privilege hop is caught before merge
- **WHEN** a change adds a workflow that checks out an event-derived ref under `workflow_run` or `pull_request_target`
- **THEN** the repository's workflow shape tests fail
