## 1. Establish reproducible tooling and baseline

- [ ] 1.1 Identify the approved planning commit in the handoff or PR after normal publication-safety checks and authorization; verify it contains the approved artifacts and remains resolvable until final acceptance.
- [ ] 1.2 Obtain scoped approval for dependency restore, the pinned skills CLI, and the selected upstream skill downloads; verify installed versions against the manifest/lock and repeat strict OpenSpec validation with the project CLI.
- [ ] 1.3 Add the allowlisted source-revision declaration and pinned skills tooling; prove the installer consumes the selected immutable revision rather than latest upstream, with a reproducible scratch installation.
- [ ] 1.4 Commit the two upstream skills, required companions/attribution, supported client links or copies, and project skill lock; verify clean-clone discovery for current Claude Code and OpenCode without personal global skills.

## 2. Validate and automate Renovate skill updates

- [ ] 2.1 Implement a small trusted updater/validator for the selected skills; fixture tests must detect changed content, missing companions, stale source/lock metadata, and paths or links escaping managed roots while proving OpenSpec files remain untouched.
- [ ] 2.2 Add and enable the Renovate custom manager and appropriate non-automerge package rules; verify extraction and digest replacement against the selected source declaration using the approved Renovate validation tooling.
- [ ] 2.3 Implement the same-PR helper with trusted base code, source/actor/repository/path checks, credential-free installation, exact-head writeback, and idempotency; fixtures must reject external branches, unauthorized actors, unexpected paths, and stale heads without pushing.
- [ ] 2.4 Integrate skill-consistency validation into applicable CI, including skill-only changes; demonstrate a revision-only update fails and regenerated output passes the focused check.
- [ ] 2.5 Implement explicit CI triggering for the regenerated head; verify with an authorized dry run that the actual required checks attach to that SHA, recording a blocker if upstream permissions or credential constraints prevent it rather than accepting stale checks.

## 3. Simplify shared documentation and agent guidance

- [ ] 3.1 Replace root `CLAUDE.md` with concise `AGENTS.md` and relocate necessary reference material without losing conventions/rationale; verify task pointers, referenced paths, and native instruction discovery for both supported clients.
- [ ] 3.2 Update `CONTRIBUTING.md` with chronological lifecycle, approved Git baseline, autonomous evolution and explicit exceptions, final tradeoff acceptance, mechanical-change path, and focused-local/applicable-CI validation; review a representative behavior change and mechanical edit against the written steps.
- [ ] 3.3 Correct browser setup to install both required engines and document relevant API/desktop validation; verify examples against package scripts and workflow definitions without claiming unrun commands passed.
- [ ] 3.4 Consolidate release-note ownership and add the small PR/review integration reference covering tracker targeting, current/archived OpenSpec sources, stable review inputs, evidence, limitations, and release overrides; check links and preserve existing release conventions.
- [ ] 3.5 Audit generated OpenSpec prompts against the agreed autonomy policy and verify compatible supported configuration/invocation; preserve CLI ownership and report any controlling conflict instead of hand-editing generated files or claiming it is solved by a prompt.
- [ ] 3.6 Simplify the delivery SVG and separate occasional maintenance from the main flow; render and visually inspect affected SVGs and verify their text matches implemented behavior and outstanding limitations.

## 4. Integrate independent review handoffs

- [ ] 4.1 Verify local review invokes separate Standards and Spec contexts using immutable base/head and revised requirements, with an explicit no-spec result where applicable; test committed review and any supported worktree-review input without silently omitting local edits.
- [ ] 4.2 Adapt the existing GitHub review workflow for trusted automatic ready/update events and trusted-maintainer authorization of external PRs; fixture tests must reject unauthorized triggers and stale head authorizations.
- [ ] 4.3 Use trusted base policy/skills, read-only review contexts, and comment-only publication; demonstrate candidate instructions cannot broaden tools or cause PR code execution, and verify actual action support for independent delegation before claiming two-axis automation works.
- [ ] 4.4 Verify review output identifies reviewed base/head and spec sources, separates both axes, stays advisory, and supports autonomous fixing or reasoned rejection with renewed affected review; use an authorized hosted review or record the exact unexecuted check and required maintainer action.

## 5. Verify and hand off

- [ ] 5.1 Run focused workflow/updater tests, whitespace/link checks, strict OpenSpec validation, and other checks required by the changed code; record exact versions, results, and untested hosted/client behavior.
- [ ] 5.2 Obtain fresh independent Standards and Spec review of the complete target-branch change, address actionable findings, and renew affected verification; retain separate axis results and unresolved findings.
- [ ] 5.3 Present the concise PR content and material plan-change explanation for approval, ask draft versus ready before publication, and request explicit human acceptance of requirement tradeoffs; verify applicable CI before final acceptance or report blockers.
- [ ] 5.4 After required acceptance and authority, sync the capability delta, archive completed planning artifacts before merge, and renew affected checks; verify final docs/specs match behavior and preserve the final change explanation without introducing permanent baseline copies.
