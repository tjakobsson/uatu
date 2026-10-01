## 1. Dashboard issue

- [x] 1.1 Create the "Agent SDK coverage" issue in `tjakobsson/uatu` with a placeholder body saying the first publication fills it. Record its number as the dashboard constant in `scripts/agent-coverage.ts`. Verify with `gh issue view <n>`.

## 2. Renderer

- [x] 2.1 Replace the matrix, badge and README-block writers with a dashboard renderer. It produces a summary (per agent: SDK version line and gap count), then each agent's state legend and axis tables, as today's matrices have them, then the hidden `agent-coverage:state v1` marker, with `--` escaped. The body contains no timestamp, SHA or run link. Verify with a test that rendering twice gives byte-identical output.
- [x] 2.2 Add marker parsing and the vocabulary diff. A missing, unknown-version or unparseable marker means no baseline. Otherwise compute the added and removed names per agent and axis, with the before and after version lines. Render the comment only when something was added or removed. Verify with tests for: marker round-trip including a name containing `--`; added and removed entries in a comment that names both versions; no comment on a version-only change; no comment with a missing or garbled marker; two accumulated bumps reported in one comment.
- [x] 2.3 Add the size guard. A rendered body over 65,536 characters throws, naming the size and the limit. Verify with a test that pads a report past the limit.
- [x] 2.4 Rework the CLI entry. With no arguments, `bun run coverage:agents` prints the body to stdout. `--previous <file> --body-out <file> --comment-out <file>` writes the body and, only when there is a diff, the comment. It writes nothing under `docs/` or to `README.md`. Verify by running it locally both ways against a body fetched with `gh issue view`.
- [x] 2.5 Delete the "since" seal, `committedBaseline`, `staleOutputs`, `renderBadge`, the README-block helpers and their tests, and remove `badge-maker` from `package.json` and `bun.lock`. Verify that `bun run typecheck` passes and `grep -rn "badge-maker\|staleOutputs\|committedBaseline" scripts src package.json` finds nothing.

## 3. CI gating

- [x] 3.1 Replace the two freshness tests with one that builds both agents' reports from the installed SDKs (controls, extraction, probes, annotations) and asserts that they succeed. Verify that it passes on `main`, and that pointing an annotation at an undeclared entry makes it fail, naming the annotation.
- [x] 3.2 Check the gating against a real bump: on a scratch branch from this change, install `@anthropic-ai/claude-agent-sdk@0.3.286` (the #472 bump) and run `bun test scripts/agent-coverage.test.ts`. Verify it passes.

## 4. Publication workflow

- [x] 4.1 Add `.github/workflows/agent-coverage.yml`. Triggers: `push` to `main` and `workflow_dispatch`. Guard: `if: github.repository == 'tjakobsson/uatu'`. Permissions: `contents: read`, `issues: write`. Checkout with `persist-credentials: false`, using the same SHA-pinned checkout and setup-bun actions and Bun version as `ci.yml`. `concurrency: { group: agent-coverage, cancel-in-progress: false }`. Steps: fetch the issue body, run the generator, post the comment if one was written, then edit the body only if it differs from the fetched one. Verify by checking the file's YAML and that every `uses:` is pinned to a SHA with a version comment.
- [x] 4.2 Before merge, run the workflow's steps by hand against the dashboard issue (fetch body, generator, `gh issue edit`), since `workflow_dispatch` only works once the file is on `main`. Verify that the issue shows the summary and both agents' tables, and that no comment was posted (no baseline). Run the steps a second time and verify that the generator produces no comment and a body identical to the published one, so the edit would be skipped.

## 5. Docs and cleanup

- [x] 5.1 Delete `docs/agents/` and replace the README's `agent-coverage` block with one sentence and a link to the dashboard issue. Verify that `grep -rn "docs/agents" --exclude-dir=node_modules --exclude-dir=.git . | grep -v openspec/changes/archive` finds nothing.
- [x] 5.2 Rewrite CONTRIBUTING's "Agent SDK coverage" section: nothing to regenerate after a bump; how to preview locally (`bun run coverage:agents`, and `--previous` for the comment); the annotation rules unchanged. Update the coverage paragraph in `ARCHITECTURE.md` and the `docs/agents/` mention in `CLAUDE.md`'s folder map. Verify by reading each section against the new behavior.
