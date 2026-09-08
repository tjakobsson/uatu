## MODIFIED Requirements

### Requirement: Clone jobs are bounded and cleaned up
The hub SHALL enforce an inactivity timeout and a hard lifetime for active clone jobs. Cancellation, timeout, hub shutdown, or clone failure SHALL terminate the clone's whole process group with bounded graceful-to-forced escalation so Git, SSH, and their descendants cannot remain orphaned. The hub SHALL reserve a clone target while its job is active so concurrent jobs cannot target the same checkout. It SHALL register a workspace only after a successful clone, SHALL release all reservations and terminal resources on every terminal outcome, and SHALL terminate all active clone jobs during graceful hub shutdown. If registration and configuration have committed and an explicitly requested session start fails, the hub SHALL preserve the configured stopped workspace and cloned checkout, and report the start failure with the registered workspace identity for correction and retry.

#### Scenario: Credential prompt is abandoned
- **WHEN** a clone waits without output or input beyond the inactivity limit
- **THEN** the job becomes timed out, its process group is terminated, and no workspace is registered

#### Scenario: Clone exceeds its hard lifetime
- **WHEN** a clone continues producing activity beyond the maximum job lifetime
- **THEN** the hub terminates it and reports a timeout rather than allowing it to run indefinitely

#### Scenario: Cancellation reaps SSH descendants
- **WHEN** an active clone has spawned SSH and the owner cancels the job
- **THEN** both Git and SSH are terminated within the bounded shutdown period

#### Scenario: Hub shuts down during clone
- **WHEN** the hub begins graceful shutdown with active clone jobs
- **THEN** it terminates and awaits those jobs before exiting

#### Scenario: Concurrent jobs choose the same target
- **WHEN** one active clone has reserved a target and another clone requests that target
- **THEN** the second request is rejected without spawning Git

#### Scenario: Session start fails after clone
- **WHEN** cloning and registration succeed but an explicitly requested workspace start fails
- **THEN** the hub preserves the configured stopped registration and checkout, reports the start failure and workspace identity, and allows correction and retry
