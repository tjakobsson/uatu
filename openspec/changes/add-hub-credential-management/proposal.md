## Why

Hub sessions currently depend on credentials inherited from the daemon's startup environment or entered into one clone job, which makes long-lived service operation fragile and gives users no coherent way to configure Git authentication or commit signing. A standalone Hub needs to own credential setup, agent lifetime, tooling readiness, and workspace assignment while stating honestly that the local backend's shared OS user is one security boundary.

## What Changes

- Add an authenticated `/settings` page for generating, upload-first importing, inspecting, testing, unlocking, locking, and deleting Hub-managed credentials without redisplaying stored private material. Keep credential cards compact until expanded and report action failures next to the controls that caused them.
- Support SSH keys for Git transport authentication and SSH commit signing, OpenPGP keys for commit signing, and HTTPS/provider tokens for Git credential-helper and `gh`/`glab` use.
- Run Hub-owned SSH and OpenPGP agent environments in dedicated owner-only locations instead of depending on ambient system agents; never modify or terminate an agent the Hub does not own.
- Auto-detect required executables, permit explicit absolute-path overrides, and expose safe capability tests and platform-specific installation guidance when tooling is absent or incompatible.
- Let credentials be assigned to selected workspaces and provide only assigned credential integrations when starting clone jobs and workspace sessions.
- Mark local-backend assignments as advisory because every workspace runs under the same OS UID; warn on settings and clone that all credentials unlocked in that Hub environment may be reachable across local workspaces. Let each user dismiss that shared advisory once across both pages. Preserve the assignment model so a future isolated backend can enforce it without changing the settings UI or persisted policy.
- **BREAKING**: Replace clone jobs' and workspace sessions' implicit ambient-agent behavior with explicit Hub credential selection while retaining the existing interactive clone PTY fallback for credentials that are not stored in the Hub. Existing service installations must import/configure Hub credentials before unattended Git authentication resumes.
- Add protected persistent records for credential metadata, tool configuration, assignments, and secret backing, plus revocation and lifecycle cleanup.
- Show each workspace's assigned authentication and signing credential names on the dashboard, and confirm before starting a stopped workspace only when it has no assignments.

## Capabilities

### New Capabilities

- `hub-credentials`: Hub-managed credential types, protected storage, dedicated agents, tool discovery and testing, workspace assignments, lifecycle, and the local-backend isolation warning.

### Modified Capabilities

- `hub-dashboard`: Keep sessions and workspaces on the dashboard, add credential management to `/settings`, and put folder registration and credential-aware cloning on `/clone`.
- `hub-service`: Start clone jobs and workspace sessions with explicit Hub-managed credential context rather than an inherited ambient SSH agent, and clean up Hub-owned agent resources safely.

## Impact

- Affects Hub configuration, state-dir persistence, authenticated APIs and pages, clone jobs, session startup, child/PTY environments, shutdown, and the self-hosting runbook.
- Introduces optional runtime integration with OpenSSH (`ssh-agent`, `ssh-add`, `ssh-keygen`), GnuPG (`gpg`, `gpg-agent`), Git credential helpers, and provider CLIs; missing optional tools degrade by capability and are diagnosed in settings.
- Adds secret-bearing state and browser-to-Hub secret submission paths that require owner-only files, atomic writes, strict response redaction, same-origin protections, and focused security tests.
- Changes Hub clone behavior from automatically retaining an inherited external SSH agent to using an explicitly selected managed credential or the existing interactive no-storage path.
- Does not add container, VM, UID, filesystem, or process isolation. The current local backend remains one shared trust domain, and no workspace assignment is represented as an enforceable least-privilege boundary.
