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
- **Committing or publishing:** read the [recorded publication exceptions](docs/agents/publication.md)
  before relying on an approval; preserve each exception's scope and normal
  publication-safety checks.
- **OpenSpec implementation:** use the [direct CLI path](docs/agents/integration.md#direct-cli-for-autonomy)
  for autonomous work, not generated apply/update wrappers. Read the same
  reference when checking native client discovery or choosing interactive
  generated workflows; their confirmation rules remain controlling when invoked.
- **Release publication or recovery:** read
  [the maintainer runbook](docs/RELEASING.md).
