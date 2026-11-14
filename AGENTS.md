# Agent guidance for uatu

uatu is a local Bun-served PWA for document previews, repository context, and
agent chat with an embedded terminal.

- **Development:** read [CONTRIBUTING.md](CONTRIBUTING.md) before planning,
  implementing, validating, or handing off a change. It owns the shared workflow,
  approval boundaries, and release-note policy.
- **Code changes:** read the [conventions](docs/agents/codebase.md#conventions)
  before editing product code or tests. The same reference preserves the feature
  map and testing rationale; use [ARCHITECTURE.md](ARCHITECTURE.md) when tracing
  runtime boundaries or extending a subsystem.
- **PR writing and review:** load [the integration reference](docs/agents/review.md)
  alongside the committed `.agents/skills/pr` or `.agents/skills/code-review`
  skill. It supplies repository-specific inputs without modifying upstream skills.
- **OpenSpec implementation:** use the [direct CLI path](docs/agents/integration.md#direct-cli-for-autonomy)
  for autonomous work, not generated apply/update wrappers. Read the same
  reference when checking native client discovery or choosing interactive
  generated workflows; their confirmation rules remain controlling when invoked.
- **Release publication or recovery:** read
  [the maintainer runbook](docs/RELEASING.md).

## Approved publication exception

For the PR from `fix/worker-activity-verification` into `tjakobsson/uatu:main`, the user approved publishing the configured Git author/committer name and email in its merge and implementation commits, including the subsequently requested upstream merge. This approval covers Git identity metadata only; review other personal or confidential content separately.

The user also approved the same configured Git identity metadata for the separate `fix/follow-redirects-advisory` PR into `tjakobsson/uatu:main`. This additional exception covers only the security patch's Git author/committer metadata.

For the PR from `fix/578-opencode-conversation-recovery` into `tjakobsson/uatu:main`, the user approved publishing the configured Git author/committer name and email in its implementation and upstream-integration commits. This approval covers Git identity metadata only; review other personal or confidential content separately.

For the draft PR from `fix/test-stability` into `tjakobsson/uatu:main`, the user approved publishing the configured Git author/committer name and email in the initial planning commit and subsequent commits for this task. This exception covers Git identity metadata only; review other personal or confidential content separately.
