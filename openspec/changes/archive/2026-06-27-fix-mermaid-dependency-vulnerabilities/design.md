## Context

`bun audit` reports 13 advisories (10 moderate, 3 low). Investigation shows
they collapse to one direct dependency, `mermaid`, plus two of its transitive
deps:

```
                              installed   vulnerable      patched          count
mermaid (direct, ^11.14.0)  ─ 11.14.0  │ <=11.14.0    │ 11.15+ (→11.16) │  4 moderate (own)
├── dompurify  (transitive) ─ 3.4.1    │ <=3.4.6      │ 3.4.7+ (→3.4.11)│  3 low + 5 mod
└── uuid       (transitive) ─ 11.1.0   │ <11.1.1      │ 11.1.1+ (→14)   │  1 moderate
                                                        ─────────────────────────────
                                                                            13
```

Two independent reasons explain why Renovate never opened a PR:

1. **In-range direct update.** mermaid 11.16.0 satisfies the existing
   `^11.14.0` range, so Renovate's default `rangeStrategy: replace` treats
   `package.json` as already up to date. Only the *lockfile* still pins
   11.14.0, and `config:recommended` does not perform lockfile-only refreshes.
2. **Transitive deps.** `dompurify` and `uuid` are mermaid's dependencies, not
   ours; Renovate does not open PRs for indirect deps under the recommended
   preset.

The current `renovate.json` is bare `config:recommended` — no
`lockFileMaintenance`, no `osvVulnerabilityAlerts`. `mermaid` is consumed as a
prebuilt asset (`import mermaidAsset from "mermaid/dist/mermaid.min.js"` in
`src/cli.ts`), so a version bump is a new bundled file with no source changes.

## Goals / Non-Goals

**Goals:**
- Clear all 13 advisories with the smallest, lowest-risk change.
- Close the Renovate blind spot so in-range and transitive advisories surface
  automatically in future.
- Make new advisories fail CI so they are caught on PRs, not by hand.

**Non-Goals:**
- Upgrading `mermaid` across a major version or changing how diagrams render.
- Touching any `src/` product code or the mermaid integration surface.
- A general dependency-update sweep beyond what is needed to clear the audit.
- Enabling GitHub Dependabot alerts as the remediation data source (we use OSV
  instead to avoid an out-of-band repo-settings dependency).

## Decisions

**Decision: Bump `mermaid` in-range, and pin patched transitive deps via
`overrides`.** Two mechanisms are needed because they fix two different layers:
- `mermaid` 11.14→11.16 clears the 4 mermaid-*own* advisories. `bun update
  mermaid` refreshes the lockfile and raises the `package.json` caret floor to
  `^11.16.0` — desirable, since it prevents a fresh install from resolving the
  vulnerable 11.14 again.
- The `dompurify` and `uuid` advisories are **not** cleared by `bun update`.
  Verified empirically: even a full `bun update` leaves mermaid's nested
  `dompurify@3.4.1` / `uuid@11.1.0` pinned, because those versions still
  satisfy mermaid 11.16's declared ranges (`dompurify ^3.3.3`,
  `uuid ^11.1.0 || … || ^14`) and bun does not bump in-range transitive deps.
  mermaid's own floor still admits the vulnerable versions, so the fix must be
  forced from our manifest. A `package.json` `overrides` block pinning
  `dompurify` and `uuid` to patched caret ranges resolves the whole tree to
  3.4.11 / 14.0.1 — both within mermaid's accepted ranges.
- *Alternative considered (and rejected):* relying on `bun update` alone — the
  original assumption. Empirically does not clear the transitive advisories.
- *Alternative considered:* `bun update dompurify uuid`. Rejected — it adds the
  packages as **direct** dependencies and still leaves mermaid's nested copies
  vulnerable; it does not dedupe the subtree.
- *Override range style:* use carets (`^3.4.11`, `^14.0.1`) so Renovate's
  `lockFileMaintenance` can float them forward to future patched releases.
- *Verification:* `bun audit` must report 0 advisories, and the Playwright
  mermaid suite must still render, before the refreshed `bun.lock` is committed.

**Decision: Enable `lockFileMaintenance` in `renovate.json`.**
This is the switch that closes *both* root causes — a periodic lockfile refresh
sweeps in-range direct updates and transitive updates that the manifest-level
managers ignore.
- *Alternative considered:* widening pins / disabling caret ranges so updates
  fall out of range. Rejected — it fights the package manager and does nothing
  for transitive deps.

**Decision: Enable `osvVulnerabilityAlerts` rather than rely on Dependabot.**
Renovate's default `vulnerabilityAlerts` reads GitHub Dependabot alerts, which
only fire if that repo feature is enabled out-of-band. `osvVulnerabilityAlerts`
queries the OSV database directly and works regardless of repo settings.
- *Alternative considered:* enabling Dependabot alerts in repo settings.
  Rejected — it is an out-of-band manual step not captured in the repo, exactly
  the kind of silent dependency this change is trying to remove.

**Decision: Add a `bun audit` step to the CI `validate` job.**
Defense in depth: even if update automation lags, a new advisory against the
installed tree fails the workflow on the PR that would introduce or carry it.
- *Placement:* alongside the existing license audit in `.github/workflows/ci.yml`,
  after `bun install --frozen-lockfile`.
- *Open sub-decision (see Open Questions):* whether the step is strict (fails on
  any advisory) or severity-thresholded.

## Risks / Trade-offs

- **`bun update` pulls unrelated transitive bumps beyond mermaid's subtree.** →
  Review the `bun.lock` diff before committing; the existing `bun test` + e2e
  suite and the binary smoke test gate behavioral regressions.
- **mermaid 11.16 changes rendering behavior despite staying on major 11.** →
  Low risk (no API surface change for our usage); the Playwright mermaid e2e
  suite is the guard. Run it explicitly as part of remediation.
- **`bun audit` becomes a flaky/blocking CI gate when a fresh advisory lands
  with no available fix.** → A new advisory failing CI is the intended signal;
  if it blocks unrelated work, the severity threshold (Open Questions) or a
  documented temporary allow is the escape hatch. Surface the trade-off rather
  than silently downgrading the gate.
- **`lockFileMaintenance` adds periodic lockfile-refresh PRs.** → Accept as the
  cost of catching this class; it can be scheduled (e.g. weekly) to limit noise.
- **An `overrides` pin can hold a transitive dep back if a future mermaid needs
  a newer major.** mermaid 11.16 still admits the vulnerable `dompurify@3.4.1` /
  `uuid@11.1.0`, so the override is needed until mermaid raises its own floor.
  If mermaid later requires `dompurify ^4` or `uuid ^15`, our caret override
  would conflict. → The override is remediation, not a permanent pin; revisit
  and remove it once mermaid's own dependency floors exclude the vulnerable
  versions. `bun install` surfaces an unmet-range error if a future mermaid
  outgrows the override, so the conflict fails loudly rather than silently.

## Migration Plan

1. Add an `overrides` block to `package.json` pinning `dompurify` (`^3.4.11`)
   and `uuid` (`^14.0.1`); run `bun update mermaid` so mermaid resolves to
   11.16.0. Confirm `bun audit` reports 0 advisories and the lockfile diff is
   limited to mermaid's subtree (mermaid, dompurify, uuid, and forced peers).
2. Run `bun test` and the Playwright mermaid e2e suite; confirm diagrams render.
3. Add `lockFileMaintenance` + `osvVulnerabilityAlerts` to `renovate.json`.
4. Add the `bun audit --audit-level=moderate` step to the CI `validate` job.
5. Commit the updated `package.json`, refreshed `bun.lock`, `renovate.json`,
   and `ci.yml` together.

Rollback: revert the commit. Because no `src/` code changes, reverting restores
the prior lockfile and config with no product impact.

## Resolved Questions

- **CI gate severity:** fail on **moderate and above** —
  `bun audit --audit-level=moderate` (exits non-zero on moderate+; lets
  low-severity noise through without blocking PRs).
- **`lockFileMaintenance` schedule:** use the **preset default** cadence (no
  explicit `schedule`); revisit only if PR noise proves disruptive.
