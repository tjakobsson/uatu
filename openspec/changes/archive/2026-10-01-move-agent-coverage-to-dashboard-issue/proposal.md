## Why

Every Renovate PR that bumps an agent SDK (`@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`, `@opencode-ai/sdk`, `@opencode/client`) goes red: #470, #472, #473 and #474 all fail the same two freshness tests in `scripts/agent-coverage.test.ts`. The committed coverage report records the exact SDK version, so any version change makes it stale, even when nothing was added or removed. #472, for example, changes only the version line and still reports 27 gaps. Renovate cannot run `bun run coverage:agents`, so none of these PRs can merge without someone pushing to them. That rules out automerge for Renovate PRs, which we want to turn on soon.

The freshness check mixes two signals. A bump that needs a code change should still fail: an annotation naming an entry the SDK removed, or declarations the extractor can no longer read. A bump that only changes the version, the vocabulary, or the gap count is information. It should reach a maintainer without blocking the merge.

## What Changes

- The coverage report moves from committed files to one GitHub issue, "Agent SDK coverage". The issue body is the dashboard: for each agent, the SDK versions, the gap count, and the full matrix it has today.
- A workflow runs the generator on every push to `main` that can change the report, and on manual dispatch, and rewrites the issue body. It uses the workflow's own token with `issues: write`. It pushes no commits and changes no branches.
- What a bump added or removed is no longer the "Since …" section of the committed matrix. The workflow posts it as a comment on the dashboard issue, comparing against the vocabulary stored in a hidden marker in the issue body. A bump that adds or removes nothing posts no comment.
- **BREAKING (repository layout)**: `docs/agents/claude-code.md`, `docs/agents/opencode.md`, their SVG badges and the generated README block are deleted. The README keeps one plain link to the dashboard issue. The two freshness tests are deleted.
- The checks that need a code change stay in the unit suite: vocabulary extraction, classification by the product's own code, ignore reasons, and annotation validation. They run against the installed SDKs on every PR, including Renovate's. A version-only bump passes them.
- `bun run coverage:agents` stays. Run locally, it prints the dashboard body and the comment a bump would post, so you can preview them without network access or a token.
- Out of scope: the Renovate automerge configuration itself, and the unrelated `bun audit` failure on the mermaid 12 PR (#355).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-coverage-report`: the report is published to a GitHub dashboard issue instead of being committed. The requirement that committed outputs match the installed SDKs is replaced by one that lets a bump fail CI only when code must change. "New vocabulary is visible per SDK version" becomes a comment on the issue. The requirement that the badge and its link stay inside the repository is removed. The stale-annotation scenario now names the unit suite instead of the freshness check.

## Impact

- `scripts/agent-coverage.ts`: the matrix, badge and README-block writers, the "since" seal and the committed-baseline logic are replaced by a dashboard renderer, a hidden-state marker, and a vocabulary diff against that marker. Extraction, probing and annotation are unchanged.
- `scripts/agent-coverage.test.ts`: the freshness and committed-output tests are dropped. Tests are added for the dashboard body, marker round-trip, diff comment, issue size limit and determinism.
- New workflow `.github/workflows/agent-coverage.yml`. Actions are pinned by SHA, as in the other workflows. Runs only in `tjakobsson/uatu`.
- Deleted: `docs/agents/` (two matrices, two SVGs). The `badge-maker` dev dependency is removed if nothing else uses it.
- Docs: `README.md` (the generated block becomes a link), `CONTRIBUTING.md` ("Agent SDK coverage" no longer says to regenerate and commit), `ARCHITECTURE.md` (the coverage paragraph), `CLAUDE.md` (the `docs/agents/` mention in the folder map).
- `tests/unit-timings.json`: the entry for `scripts/agent-coverage.test.ts` stays, though its timing will change.
- No product code, HTTP API or wire contract changes. Nothing ships in the binary.
