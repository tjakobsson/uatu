# Tasks — adopt-openssf-baseline

Work lands via a single PR from `chore/adopt-openssf-baseline` per the
repository's PR-only convention. The repository-settings tasks (section 4)
are `gh api` invocations, not file changes — run them after the PR merges
so the ruleset never blocks its own change.

## 1. Security policy

- [x] 1.1 Write root `SECURITY.md`: supported version (latest release), reporting via GitHub private vulnerability reporting, acknowledgement within 7 days, in-scope areas (terminal auth token, markdown/asciidoc/mermaid sanitization, file-serving path handling, release-artifact integrity) and out-of-scope (attacks requiring the local user's own privileges)

## 2. Measurement and analysis workflows

- [x] 2.1 Add `.github/workflows/scorecard.yml`: `ossf/scorecard-action` SHA-pinned, weekly schedule + push to `main` + `workflow_dispatch`, `publish_results: true`, SARIF upload to code scanning, permissions per the action's documented requirements
- [x] 2.2 Add `.github/workflows/codeql.yml`: `github/codeql-action` SHA-pinned, language `javascript-typescript`, build-mode `none`, triggers on PRs to `main`, pushes to `main`, weekly schedule; `paths-ignore` for `testdata/` and docs
- [x] 2.3 Confirm Renovate picks up both new workflows for action-pin updates (no config change expected; `enabledManagers` already includes `github-actions`)

## 3. Release provenance as assets

- [x] 3.1 Extend `.github/workflows/release.yml` publish job: after attestation, run `gh attestation download` for each of the four archives and upload the resulting `<asset>.sigstore.json` bundles as release assets
- [x] 3.2 Update `docs/RELEASING.md` verification section to cover the new provenance-bundle assets and how to verify one with standard Sigstore tooling

## 4. Repository settings (post-merge, via gh api)

- [x] 4.1 Enable private vulnerability reporting: `gh api -X PUT repos/tjakobsson/uatu/private-vulnerability-reporting`
- [x] 4.2 Create the `main` ruleset via `gh api repos/tjakobsson/uatu/rulesets`: target `main`; rules = require pull request (0 required approvals), require status check `validate`, block force pushes, restrict deletions; enforcement active; no bypass actors (ruleset id 20131739)
- [x] 4.3 Verify the ruleset: a direct push to `main` is rejected, and a test PR shows `validate` as required (verified: GitHub web UI refuses committing a file directly to `main`)

## 5. Documentation and verification

- [x] 5.1 Add the OpenSSF Scorecard badge to `README.md`
- [x] 5.2 Update `CONTRIBUTING.md` if its merge-mechanics wording needs to reflect the enforced ruleset

## Post-merge verification (not tasks — happens after this change's PR)

These outlive the PR, so they are prose rather than checkboxes:

- After merge, trigger the scorecard workflow via `workflow_dispatch`;
  confirm results publish to the OpenSSF API and the Branch-Protection,
  Security-Policy, and SAST checks now score.
- After the next tagged release, confirm the release page carries the four
  `.sigstore.json` bundles and the Scorecard Signed-Releases check credits
  them. If not, adjust bundle naming in a follow-up change.
