## 1. Mock-backed realistic Hub UI first

- [ ] 1.1 Build a loopback-only demo server and dedicated Playwright fixture under `tests/e2e/` using the real server-rendered Hub presentation and an in-memory HTTP/state adapter; verify no Git, real Hub persistence, credential store, provider runtime, remote fetch or workspace child spawn is reachable, including unknown mutation routes.
- [ ] 1.2 Add visible demo/scenario controls and deterministic reset under `tests/`, with synthetic workspace/credential data and controllable latency; verify reset restores fixtures after simulated create/start/delete and no authentication secrets are required or retained.
- [ ] 1.3 Implement reusable Hub creation/inventory presentation for new branch+base, existing local and remote tracking modes, explicit destination/name/assignments and stopped-by-default results; verify all three successful flows plus loading and empty states against mocks.
- [ ] 1.4 Implement mock branch/path conflict and already-checked-out open flows plus stale remote/ref freshness and explicit fetch pending/success/auth/network failure; verify no force option, silent ref substitution or duplicate submission is offered.
- [ ] 1.5 Implement retained-checkout registration failure, retry-registration, start failure, external discovery and missing/replaced-path states; verify retry preserves simulated identity, discovery never switches current selection, and error recovery does not duplicate checkouts.
- [ ] 1.6 Implement mock delete/forget/rename-guard UI with clean success, dirty/untracked/ignored/locked/in-use blockers, stop failure, preserved-branch default and separately confirmed safe branch failure; verify forget preserves checkout and external trees have no destructive ownership action.
- [ ] 1.7 Implement realistic navigation through dashboard/onboarding, stopped Start, running Open, `/s/<fixture-id>/` fixture destinations, return/back/forward and opening indicators without child startup; verify destination workspace identity and unchanged source context.
- [ ] 1.8 Run desktop and narrow-touch mock E2E coverage including keyboard/focus/errors, light/dark, titlebar inset, reset, live discovery/reconnect and simulated slow operations; capture screenshots and behavior reports via `tests/e2e/evidence.ts` in Playwright output and verify the evidence-discipline test passes without tests naming an OpenSpec folder.

## 2. Explicit user UX approval gate — STOP here

- [ ] 2.1 Present the runnable demo instructions, scenario matrix and evidence for user review, clearly separating simulation from untested real backend/provider behavior; verify the review packet covers all section 1 outcomes and records remaining UX issues.
- [ ] 2.2 Obtain and record explicit user UX approval and resolve required prototype revisions, rerunning affected tests; verify the actual user decision is recorded before marking this task complete. Do not infer approval from planning completion or green tests. All sections below remain blocked until this gate is satisfied.

## 3. Post-approval service foundations and safety

- [ ] 3.1 Define the shared worktree operation DTOs, bounded phases, ownership/identity model and sanitized error contract, following the approved UI; verify contract fixtures cover all prototype states and existing public API publication checks accept the additions.
- [ ] 3.2 Add Git capability/ref/inventory probes and canonical common-directory identity with repository serialization plus existing path reservations; verify temporary-repository tests cover main/linked sources, unusual paths, option-like inputs, symlinks, branch collisions and concurrent operations, and document unsupported Git/submodule cases.
- [ ] 3.3 Add durable operation intent/provenance and recovery coordination with onboarding registration/assignments; verify injected persistence failures, restart at each creation boundary, idempotent retry, forget/re-register and replaced-path cases never confer false ownership or delete uncertain content.
- [ ] 3.4 Guard generic folder rename against linked/main/common-directory and ancestor dependencies, including unregistered worktrees; verify server tests reject unsafe and inconclusive moves even with stop authorization while safe unrelated rename and display-name edits still work.

## 4. Post-approval creation and authenticated operations

- [ ] 4.1 Implement bounded non-force Git creation for new branch/base, existing local and remote tracking modes; verify real temporary-repository tests assert exact branch/base/upstream, branch-in-use open hints, destination preservation and dirty-source independence.
- [ ] 4.2 Implement explicit credential-aware remote fetch and freshness reporting without ambient/unselected credential fallback; verify selected/none/locked/disabled/auth failure cases and sanitized output using clean tool-environment credential tests.
- [ ] 4.3 Connect verified checkouts to atomic onboarding with explicit assignments and optional start; verify stopped default, no implicit inheritance, retained checkout on registration failure, same-checkout retry and preserved stopped configuration on start failure.
- [ ] 4.4 Expose authenticated Hub operations/progress/recovery to the UI, scoped to authorized callers; verify unauthenticated, cross-origin cookie, wrong-user operation access, timeout/cancellation and partial-resource outcomes, including bounded subprocess cleanup.

## 5. Post-approval discovery and guarded removal

- [ ] 5.1 Implement Git-based reconciliation on open, relevant activity, manual refresh and bounded periodic cadence; verify deterministic timer/activity tests coalesce refreshes, preserve external provenance and report missing/replaced paths without switching, auto-registration or recreation.
- [ ] 5.2 Add the `worktrees` invalidation topic to broker/client and public contracts; verify immediate notification after UI/CLI-equivalent operations, reconnect recovery, authorization, one live connection per visible page and unchanged content-free activity payloads.
- [ ] 5.3 Implement deletion preflight for ownership, identity, tracked/untracked/ignored data, locks, nested dependencies and known activity; verify each blocker retains checkout/registration and main/external/unknown trees cannot be deleted.
- [ ] 5.4 Implement confirm-stop-fence-recheck-non-force-remove-unregister with recovery journaling; verify failed stop/remove, in-flight/concurrent start, cleanup persistence failure and path reuse after removal do not lose files or accidentally delete a new occupant.
- [ ] 5.5 Implement separate safe branch deletion choice and provenance-preserving forget behavior; verify branch preservation by default, Git refusal without force, stopped-only forget and external checkout/branch preservation.
- [ ] 5.6 Replace the approved UI's fake transport with the real Hub operation contract while retaining the isolated demo; verify the same state matrix against temporary repositories and existing dashboard/create/clone/switcher regression tests.

## 6. Post-approval CLI and provider skills

- [ ] 6.1 Finalize proposed CLI spelling/flags and authenticated Hub-context transport with least-privilege/revocation and secret-redaction review; verify a documented threat model and contract examples cover missing/expired/wrong Hub context without assuming an installed Uatu executable.
- [ ] 6.2 Implement CLI dispatch as a thin authenticated Hub client with structured progress/results/recovery and explicit destructive confirmation; verify transport tests prove parity with UI safety, no independent Git fallback, and no secrets in arguments/output.
- [ ] 6.3 Define opt-in Claude/OpenCode skill packaging and add thin guidance for explicit persistent workspace requests; verify fixture-based loading/documentation tests preserve existing user/project configuration and do not replace native hooks or invoke experimental provider removal/reset.
- [ ] 6.4 Test actual available supported Claude/OpenCode binaries in separate workspaces, requesting permission before any installation; verify new/resumed conversation directory boundaries and native worktree/subagent coexistence, and record unavailable tools as untested rather than claiming compatibility.

## 7. Integrated acceptance and documentation

- [ ] 7.1 Run cross-surface temporary-repository acceptance for terminal, preview, search, Git and chat checkout identity plus CLI-triggered live appearance; verify source conversations/selection remain unchanged and external cleanup produces a truthful missing state.
- [ ] 7.2 Run broader unit/E2E/public-contract and recovery regressions, capture final desktop/touch evidence using existing evidence helpers, and perform a native macOS navigation smoke test when available; record exact results and distinguish browser emulation from native verification.
- [ ] 7.3 Document creation modes, credential selection, external ownership, ignored data, safe delete versus forget, partial recovery, CLI/skill setup and rollback; verify examples against implemented commands and ensure no documentation claims worktree security isolation or guaranteed native transcript import.
