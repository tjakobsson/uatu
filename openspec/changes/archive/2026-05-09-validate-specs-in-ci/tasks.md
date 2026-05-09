## 1. Add the OpenSpec CLI as a tracked devDependency

- [x] 1.1 Add `@fission-ai/openspec` to `devDependencies` in `package.json`, pinning to the version currently used locally (`1.2.0` as of authoring; bump if newer at implementation time). *Pinned `^1.2.0`; resolved to `1.3.1`.*
- [x] 1.2 Run `bun install` and confirm `bun.lock` updates with the new package and its transitive deps. *73 packages installed, lockfile updated.*
- [x] 1.3 Confirm `bunx @fission-ai/openspec validate --all --strict` resolves through the lockfile and passes locally. *15 specs + 1 in-flight change pass.*

## 2. Add the new CI job

- [x] 2.1 Add a `validate-specs` job to `.github/workflows/ci.yml`, parallel to the existing `validate` job
- [x] 2.2 Job steps: checkout (pinned SHA, matching the existing job), setup Bun (pinned version, matching the existing job), `bun install --frozen-lockfile`, then `bunx @fission-ai/openspec validate --all --strict`
- [x] 2.3 Set a short `timeout-minutes` (e.g. 5) — spec validation should finish in well under a minute
- [x] 2.4 Confirm action SHAs are pinned (no floating major tags) per `repository-workflows` requirement. *Reused the same SHAs as the existing `validate` job; no new action references introduced.*

## 3. Verify the workflow

- [x] 3.1 Run `openspec validate validate-specs-in-ci` to confirm the change validates
- [x] 3.2 Confirm a deliberately-broken spec (e.g. a scenario with `### Scenario:` instead of `#### Scenario:` on a temporary branch) makes the new job fail, then revert. *Local probe: 3-hashtag scenario header produced `Totals: 15 passed, 1 failed (16 items)`; restored and re-verified to 16/16 passing.*

## 4. Spec sync at archive

- [x] 4.1 Run `openspec archive validate-specs-in-ci` to apply the `repository-workflows` MODIFIED delta into the main spec. *Applied: 1 requirement modified, new scenario added.*
- [x] 4.2 Confirm `openspec validate --all --strict` still passes against the updated main specs after archive. *Result: 15 passed, 0 failed.*
