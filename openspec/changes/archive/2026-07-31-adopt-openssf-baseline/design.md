# Design — adopt-openssf-baseline

## Context

uatu's repository hygiene is already strong where it lives in files: all GitHub Actions are SHA-pinned with Renovate keeping the pins current (`enabledManagers` includes `github-actions`), every workflow declares least-privilege token permissions, `bun audit` gates PRs and runs as a weekly scheduled backstop, and the release workflow generates GitHub build-provenance attestations plus `SHA256SUMS`. The gaps are the ones that live in repository *settings* and in *missing* files: `main` is entirely unprotected (no ruleset, no classic protection), there is no `SECURITY.md`, no SAST runs, and nothing measures or publishes the security posture. The public Scorecard API has no data for the repo, so measurement must be self-hosted via `ossf/scorecard-action`.

The maintainer already works PR-only by convention; this change makes that enforceable without breaking the solo-maintainer flow.

## Goals / Non-Goals

**Goals:**
- Enforce PR-only merges to `main` with the CI `validate` check required, via a repository ruleset.
- Publish a vulnerability disclosure policy backed by GitHub private vulnerability reporting.
- Run CodeQL over the TypeScript codebase on PRs and on a schedule.
- Run OpenSSF Scorecard on a schedule, publish results to the OpenSSF API, and make the score visible.
- Make release provenance discoverable in release assets, not only in the GitHub attestation store.

**Non-Goals:**
- CodeQL for the Swift desktop wrapper (needs macOS runners; can be a follow-up change).
- Fuzzing the render pipeline (a plausible future change — uatu renders untrusted markdown/asciidoc/mermaid — but out of scope here).
- OpenSSF Best Practices badge registration (a manual questionnaire on bestpractices.dev; this change satisfies its hard prerequisites but registration is a separate maintainer action).
- Required PR approvals > 0 (would deadlock a solo maintainer; revisit if the project gains a second maintainer).

## Decisions

### Ruleset, not classic branch protection
GitHub repository rulesets are the current mechanism (classic branch protection is legacy), are readable via the same API Scorecard queries, and are manageable as reviewable JSON via `gh api`. The ruleset targets `main` with: require pull request before merging (0 required approvals), require the `validate` status check (the CI workflow's single job — there is no separate fast job to prefer), block force pushes, block deletions. No bypass actors: Release Please merges via PR and the release workflow pushes *tags*, which a `main` branch ruleset does not gate, so nothing in the automation needs a bypass. Scorecard's Branch-Protection check scores tier-wise, so 0-approvals still earns the tiers below "requires review".

### Scorecard via `ossf/scorecard-action` with published results
Weekly schedule plus `push` to `main` (branch-protection changes only re-score on push/schedule). `publish_results: true` feeds the OpenSSF REST API and enables the badge. The workflow also uploads SARIF to code scanning so findings appear in the Security tab. Permissions: `security-events: write` and `id-token: write` in the job, top-level `read-all` per the action's documented requirements — this workflow is the one place uatu's usual minimal-permissions shape follows the action's own hard requirements instead. SHA-pinned like every other action; Renovate maintains the pin.

### CodeQL scoped to `javascript-typescript`, build-mode `none`
One workflow, `github/codeql-action`, language matrix of just `javascript-typescript` (CodeQL scans TS without a build). Triggers: `pull_request` to `main`, `push` to `main`, weekly schedule. `paths-ignore` for `testdata/` and docs to keep PR latency low. Swift deliberately excluded (Non-Goal). This fills Scorecard's SAST check, which looks for CodeQL runs on recent commits.

### Provenance published as release assets via `gh attestation download`
The publish job already has the four archives and a `GH_TOKEN`; after attestation, it downloads each archive's Sigstore bundle (`gh attestation download <asset> --repo tjakobsson/uatu`) and uploads the bundles (`<asset>.sigstore.json`) as release assets alongside `SHA256SUMS`. Alternatives considered: cosign-signing `SHA256SUMS` (new key/tooling surface, duplicates what attestations already prove) and the SLSA generator workflow (heavyweight rework of a release pipeline that already attests). Downloading the existing attestation is the smallest change that makes provenance visible to Scorecard's Signed-Releases check and to users without `gh`.

### SECURITY.md backed by GitHub private vulnerability reporting
Private vulnerability reporting (PVR) gives a private advisory workflow with no email address to maintain and is what Scorecard/Best Practices expect a policy to point at. `SECURITY.md` states: supported version (latest release only), how to report (PVR link), response expectation (acknowledgement within 7 days), and scope guidance for a local-first tool — in scope: the terminal auth token scheme, markdown/asciidoc/mermaid sanitization, file-serving path handling, release-artifact integrity; out of scope: attacks requiring the local user's own privileges. Enabling PVR is a settings task via `gh api`.

### Settings changes are tasks, applied via `gh api`, verified by Scorecard
The ruleset and PVR toggle are not files in this repo. They are captured as explicit tasks (with the exact `gh api` invocations) so the change is reproducible, and the scorecard workflow provides the ongoing regression signal if settings drift.

## Risks / Trade-offs

- [Ruleset blocks an urgent direct push (hotfix, bookkeeping)] → That is the point; the escape hatch is deliberately manual — temporarily disable the ruleset in settings, not a standing bypass actor.
- [Required `validate` check makes every merge wait on full CI (~build + unit + smoke)] → Accepted; it is the existing PR gate and there is no faster job to require. If it grows painful, split CI into fast/slow jobs in a follow-up.
- [CodeQL adds PR latency and possible false positives] → TS-only with path filters keeps runs to a few minutes; findings surface in the Security tab rather than failing PRs (default CodeQL behavior — `security-events` upload, not a required check).
- [`publish_results: true` makes the score public even while it is mediocre] → Acceptable; the score improves within this same change, and public measurement is the goal.
- [Scorecard may still not credit release assets if its Signed-Releases heuristics expect specific filenames] → `.sigstore.json` bundles are what current Scorecard recognizes; the scorecard workflow itself verifies this after the next release. If not credited, adjust naming (e.g. `.intoto.jsonl`) in a follow-up — the asset upload mechanism stays the same.
- [Ruleset applies to Release Please's PR merges] → Release Please merges through the PR UI/API like any PR; required `validate` check runs on its PRs today already. No bypass needed.

## Open Questions

- Whether to add the Scorecard badge to `README.md` immediately or wait until the score stabilizes after the first few runs (cosmetic; default: add it in this change).
