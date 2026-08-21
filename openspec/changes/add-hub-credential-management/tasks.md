## 1. Credential State Foundation

- [x] 1.1 Add credential, capability, assignment, tool-override, readiness, and public-DTO types with strict parsers that reject unknown or secret-bearing public fields.
- [x] 1.2 Add state-dir path helpers and bootstrap owner-only `credential-secrets`, `credential-gnupg`, and ownership-preserving `credential-runtime` directories, including symlink and unsafe-permission rejection tests.
- [x] 1.3 Implement the serialized atomic credential metadata store, token secret store, and tool-override store with rollback-on-write-failure and restart persistence tests.
- [x] 1.4 Implement assignment mutation rules, including stable credential ids, no assignments by default, one authentication default per provider host, host-specific removal, one signing default per workspace, assignment/forget serialization, forget cleanup, and transactional delete-and-unassign.

## 2. Tool Discovery And Diagnostics

- [x] 2.1 Implement bounded executable discovery and absolute-path validation for the OpenSSH client and key/agent tools, GnuPG, Git, `gh`, and `glab` without shell interpolation.
- [x] 2.2 Implement layered version/runtime/readiness probes with timeouts, output caps, sanitized structured results, and independent degradation per capability.
- [x] 2.3 Add platform-specific installation/path guidance and tests proving diagnostics do not include environment values, command input, private material, or unbounded stderr.
- [x] 2.4 Persist validated tool overrides, serialize mutation with re-probing and SSH runtime replacement with in-flight credential operations, degrade stale persisted overrides without blocking startup, re-probe after mutation, and keep a failed override from replacing the last usable configuration.

## 3. Managed SSH Credentials

- [x] 3.1 Implement a supervised Hub-owned `ssh-agent` using a fixed owner-only runtime socket, lazy startup, ownership tracking, owned-artifact cleanup after unexpected exit, stale-state recovery, and bounded shutdown.
- [x] 3.2 Implement passphrase-protected SSH key generation and duplicate-safe private-key import that preserves existing key protection, using a private no-echo PTY for encrypted keys and automatic loading for unencrypted keys while storing native key files owner-only and deriving public metadata without exposing secrets.
- [x] 3.3 Implement SSH unlock, lock, disable, delete, and per-assigned-key usability tests through the managed agent, with backing-file failures isolated to the affected credential and all passphrases excluded from argv, environment, logs, captured output, and persistence.
- [x] 3.4 Add integration tests with an ambient fake/system agent proving Hub startup, key operations, and shutdown use only the Hub socket and never signal or mutate the ambient agent.

## 4. Managed OpenPGP Credentials

- [x] 4.1 Implement dedicated-`GNUPGHOME` generation and import of OpenPGP signing keys, returning only public key and fingerprint metadata and degrading cleanly when GnuPG is unavailable.
- [x] 4.2 Implement explicit OpenPGP unlock through a bounded loopback signing probe, agent-cache readiness detection, metadata-scoped disable/delete behavior with cleanup rollback under the metadata lock, and Hub-shutdown-only `gpg-agent` termination.
- [x] 4.3 Add local sign-and-verify capability tests using a fixed challenge and tests proving passphrases, pinentry responses, and private exports never enter retained output or API DTOs.
- [x] 4.4 Add integration coverage proving the Hub GnuPG home and lifecycle remain separate from an existing system GnuPG home and agent.

## 5. HTTPS And Provider Credentials

- [x] 5.1 Add HTTPS/provider token creation, host normalization, assignable Git/provider-CLI capabilities including provider-only tokens, enable/disable behavior, deletion with secret cleanup and rollback under one metadata transaction, and owner-only persistence.
- [x] 5.2 Add the compiled binary's internal Git credential-helper mode using the standard stdin/stdout protocol, exact protocol/host matching, bounded input, and no logging.
- [x] 5.3 Add `gh` and `glab` runtime adapters that create provider-specific configuration outside repositories, reject ambiguous multi-host projection, and report unsupported or missing CLI versions independently.
- [x] 5.4 Add tests proving tokens never appear in remote URLs, process arguments, repository files, API responses, clone output, or mismatched-host credential-helper responses.

## 6. Workspace Credential Contexts

- [x] 6.1 Extend the session-backend contract with a resolved credential context, quote generated SSH paths, isolate each session generation's runtime cleanup, and update all local, fake, integration, and test backends to consume it explicitly.
- [x] 6.2 Generate runtime-only SSH and Git configuration for assigned authentication and SSH/OpenPGP signing defaults while preserving unrelated user Git configuration.
- [x] 6.3 Generate HTTPS helper and provider-CLI runtime context for assignments, reject provider-CLI assignments while their CLI is unavailable, strip ambient credential variables, and ensure a workspace with no assignments receives no Hub or ambient credential integration.
- [x] 6.4 Wire the generated context through `uatu serve` into newly created embedded PTYs and report when assignment changes require a running workspace restart.
- [x] 6.5 Add adversarial local-backend tests showing normal Git configuration selects assignments while the product warning and docs explicitly acknowledge that same-UID processes can bypass them.

## 7. Clone Credential Selection

- [x] 7.1 Extend clone creation with optional credential id and retain-assignment fields, validating remote transport/provider compatibility before a process starts.
- [x] 7.2 Build each clone's explicit managed SSH or HTTPS selection context, remove inherited agent/helper variables, and preserve the existing no-selection interactive PTY fallback.
- [x] 7.3 Coordinate clone success, workspace registration, retained assignment, and session-start rollback so failures leave neither phantom registrations nor dangling assignments.
- [x] 7.4 Extend clone unit and integration tests for selected unlocked/locked credentials, unselected-credential non-fallback, interactive one-operation secrets, cancellation, timeout, and secret redaction.

## 8. Authenticated Credential APIs

- [x] 8.1 Add authenticated routes for credential/tool listing, public-key export, generate/import, unlock/lock, enable/disable, assignment, testing, and confirmed deletion using explicit public response DTOs.
- [x] 8.2 Apply POST plus same-origin enforcement, no-store secret responses, bounded/rate-limited expensive operations, strict content validation, and request-body-safe errors to every mutation.
- [x] 8.3 Add API integration tests for cross-user trust-model behavior, cross-origin rejection, malformed inputs, reference conflicts, transactional deletion, restart state, and absence of private material.
- [x] 8.4 Extend Hub shutdown ordering so clone jobs and workspace sessions stop before owned credential agents, while optional runtime failures do not block unrelated capabilities.

## 9. Authenticated Page Experience

- [x] 9.1 Add the Credentials settings page using existing Hub visual patterns, with credential summaries, readiness layers, public-key copy, and capability-specific forms.
- [x] 9.2 Add masked generate/import/unlock/token inputs, tool path overrides and Test actions, destructive confirmations, workspace-oriented authentication/signing assignment controls, and restart-required status.
- [x] 9.3 Add the persistent shared-UID warning to local-backend assignment and clone surfaces and ensure no copy describes assignments as isolation or least privilege.
- [x] 9.4 Extend the dedicated clone page with compatible credential selection, locked-credential unlock flow, retain-assignment choice, and unchanged interactive fallback behavior.
- [x] 9.5 Add authenticated-page DOM/unit and E2E coverage for missing tools, successful tests, secret non-redisplay, SSH/OpenPGP/token lifecycle, assignments, clone selection, errors, and mobile/desktop layouts.

## 10. Contracts, Migration, And Validation

- [x] 10.1 Update public Hub API schemas, route contracts, compatibility fixtures, and revision/changelog metadata through Hub revision 4 for credential DTOs, clone request changes, and the `ssh` tool enum.
- [x] 10.2 Update the self-hosting runbook and trust model with tool installation, managed-agent separation, credential setup, provider public-key registration, assignment semantics, shared-UID limits, backup, revocation, and rollback guidance.
- [x] 10.4 Run focused credential security tests, the full unit suite, typecheck, license audit, standalone build, E2E suite, API contract validation, and strict OpenSpec validation; resolve every failure before marking the change complete.

## 11. Page Split And Contract Follow-up

- [x] 11.1 Split authenticated Hub content across dashboard, `/clone`, and `/settings` with shared navigation, page-scoped initialization, independent clone credential loading, and preserved return-to and bfcache behavior.
- [x] 11.2 Exclude the HTML routes from the public operation contract, add required `HubWorkspace.credentialRestartRequired` contract coverage and compatibility metadata, and verify focused Hub/API tests, typecheck, and build.

## 12. Settings UX And Tool Discovery Follow-up

- [x] 12.1 Remove the ambient-agent migration announcement and its tests while retaining the self-hosting migration documentation.
- [x] 12.2 Make the shared-UID advisory dismissible through one per-user browser key shared by settings and clone, and remove repeated assignment confirmation.
- [x] 12.3 Collapse credential cards by default, preserve expanded cards across refreshes, improve status summaries, and restructure assignment management around current rows and explicit replacement copy.
- [x] 12.4 Route credential form, card action, assignment, and tool override failures to contextual alerts; keep the page alert for load failures.
- [x] 12.5 Make SSH import upload-first with optional paste, exactly-one-source and 1 MiB checks, asynchronous request building, and secret/file cleanup after every attempt.
- [x] 12.6 Accept executable symlink chains while preserving configured paths, and cover valid, dangling, directory-target, non-executable-target, and conditional Homebrew `gh` discovery cases.
- [x] 12.7 Normalize inline action and assignment control heights, place unlock on its own row, and use a responsive workspace assignment grid with concise default-replacement copy.

## 13. Workspace Credential Indication Follow-up

- [x] 13.1 Add a secret-free, deduplicated authentication/signing assignment summary to every `HubWorkspace`, with empty arrays when credential services are absent.
- [x] 13.2 Show neutral assignment summaries on running and stopped rows and confirm a stopped workspace start only when both assignment arrays are empty.
- [x] 13.3 Update the required public schema, populated examples and contract tests, Hub revision metadata, changelog migration guidance, and integration coverage.
- [x] 13.4 Run focused page, Hub, and API tests, typecheck, API validation, strict OpenSpec validation, build, and diff checks.
