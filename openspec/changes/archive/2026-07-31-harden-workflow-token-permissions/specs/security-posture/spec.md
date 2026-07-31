# security-posture Delta Specification

## ADDED Requirements

### Requirement: Workflow token permissions are granted at job level only
Every GitHub Actions workflow SHALL declare an explicit workflow-level `permissions` block that grants no write scopes (empty or read-only), and any write scope a job needs MUST be granted in that job's own `permissions` block. A workflow file MUST NOT rely on the repository's default token permissions by omitting the workflow-level block.

#### Scenario: No workflow grants write at the top level
- **WHEN** the workflow files under `.github/workflows/` are inspected
- **THEN** no workflow-level `permissions` block contains a write scope
- **AND** every write scope appears only on the specific job that requires it

#### Scenario: A future job defaults to no permissions
- **WHEN** a new job is added to an existing workflow without its own `permissions` block
- **THEN** it inherits the workflow-level grant of none (or read-only) rather than any write scope
