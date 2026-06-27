## Why

`bun audit` reports 13 advisories (10 moderate, 3 low), all rooted in the
single direct dependency `mermaid` and its transitive deps `dompurify` and
`uuid`. Every advisory is already fixed upstream, yet Renovate never opened a
PR — because the fixes are either *in-range of the existing caret* (mermaid
11.16.0 satisfies `^11.14.0`, so `rangeStrategy: replace` leaves
`package.json` untouched) or *transitive* (dompurify/uuid are not declared in
our manifest, and `config:recommended` does not bump indirect deps). The bare
Renovate config has no `lockFileMaintenance` to refresh the lockfile and no
OSV-based vulnerability scanning, so this class of advisory will keep
accumulating silently.

## What Changes

- Bump `mermaid` 11.14→11.16 via `bun update mermaid` (raises the
  `package.json` caret floor to `^11.16.0` so a fresh install cannot regress to
  the vulnerable 11.14; stays on major 11, no breaking change) to clear the 4
  mermaid-own advisories. The bundled `mermaid/dist/mermaid.min.js` asset
  (`src/cli.ts`) updates automatically.
- Add a `package.json` `overrides` block pinning `dompurify` (`^3.4.11`) and
  `uuid` (`^14.0.1`) to patched versions for the whole tree. mermaid's own
  dependency floors still admit the vulnerable `dompurify@3.4.1` /
  `uuid@11.1.0`, and `bun update` does not bump in-range transitive deps, so
  the fix must be forced from our manifest. Both pins are within mermaid 11.16's
  accepted ranges.
- Harden `renovate.json` so this no longer slips through: enable
  `lockFileMaintenance` (periodic lockfile refresh sweeps in-range and
  transitive updates) and `osvVulnerabilityAlerts` (OSV-database scanning that
  does not depend on GitHub Dependabot alerts being enabled).
- Add a `bun audit` step to the CI `validate` job so new advisories surface on
  pull requests instead of by manual discovery.

## Capabilities

### New Capabilities
<!-- None. This change refreshes a dependency lockfile and strengthens existing
     repository-automation requirements; it introduces no new product capability. -->

### Modified Capabilities
- `repository-workflows`: Strengthen the "Repository tooling versions are kept
  current" requirement so update automation must also surface published
  *security advisories*, including those affecting transitive dependencies and
  versions already satisfied by an existing manifest range. Extend the "GitHub
  Actions validate the repository" requirement so the minimum validation set
  includes a dependency vulnerability audit that fails the workflow on new
  advisories.

## Impact

- `package.json` — add an `overrides` block (dompurify, uuid).
- `bun.lock` — refreshed (mermaid 11.16.0, dompurify 3.4.11, uuid 14.0.1).
- `renovate.json` — add `lockFileMaintenance` and `osvVulnerabilityAlerts`.
- `.github/workflows/ci.yml` — add a `bun audit --audit-level=moderate` step to
  the `validate` job.
- No `src/` product code changes; `mermaid` API surface used by
  `src/preview/mermaid*.ts` and `src/render/` is unchanged across 11.14→11.16.
- Security posture: mermaid sanitizes diagram source from the watched docs
  tree client-side, so these XSS/CSS-injection/gantt-DoS advisories only bite
  when previewing untrusted documents — low real-world risk for a local
  single-user tool, but cheap to keep patched.
