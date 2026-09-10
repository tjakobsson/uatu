# Page-based Settings — current review candidate

2026-09-10. The user rejected Settings drawers, generic More menus and embedded
Troubleshooting, then explicitly selected **full-page editors**. This implements
that model rather than restyling the drawer. No visual approval is inferred.

Frontend fingerprint:
`sha256:5ed20838d9c8813222b8a0ffd972efbb916cc698d95611b85c4317a778671d65`.

## Current interaction model

- Credential, tool, workspace, assignment, folder, account and clone-management
  commands are visible in their relevant view. No generic More menus hide them.
- Folder children remain compact hierarchy rows. Current-folder operations live
  in that folder's view rather than being repeated as large cards on each child.
- State-appropriate key commands avoid offering Unlock for a known-unlocked key
  or Lock for a known-locked key. OpenPGP and tokens do not acquire SSH-only Lock.
  Unknown state stays explicit; supported operations are not inferred from prose.
- Full-page editors have one header Back/Cancel and Save/Apply. Read-only pages
  use Back. There is no drawer, grabber or editor backdrop; only consequential
  confirmations use a small centered dialog. Ordinary startup choices are pages.
- Direct commands that do not navigate, such as Copy identifier and Lock, do not
  misleadingly display a disclosure chevron. Long public values are full-width.
- Normal Settings contains no Troubleshooting or diagnostic accordion. **Check
  setup / Recheck installed tools** opens Check Results. **View diagnostic report**
  there exposes every supplied result; Back returns to those results without
  another request. The distinction between local checks and remote access remains.
- Full-page input focus is inset within its field, avoiding the earlier outline
  overlapping the label and rounded surface. Interactive keyboard focus remains.

## Lifetime and history safeguards

One task-view module owns presentation, focus, pending state and secret clearing.
It uses the existing coordinator history seam, not a second workspace singleton.
Editor → Review → Back to edit preserves the owned draft in one workflow entry.
Save/Cancel and synchronous result navigation do not leave a redundant Back step
or let a delayed history pop overwrite a newly opened detail. Forward to an expired
entry restores safe context, not secret fields or an operation replay.

Same-context browser Back during a pending submission remains blocked, like its
disabled header control, with a visible explanation. Tests hold responses after
real synthetic Create/Assignment effects and verify one command and a retained
success/partial-failure result. Other-destination navigation, authentication loss
and document reload remain distinct abandonment boundaries.

Read-only workspace-name enrichment has authenticated-owner and exact-region
ownership independent of editor generations. It can finish behind Rename without
getting stuck at Loading or swallowing an authoritative same-session 401.

The earlier cold-entry loading/Back/geometry/Hub-link repair remains in place.
No provider, executable shell, PTY, live credential/clone, public API or dependency
work was added. No commits, spec sync or archive were performed.

## Verification and honest limits

Latest lead command:

```sh
bun test src/hub/mobile tests/mobile-hub-review src/shell/navigation-cold-boot.test.ts src/shell/hub-nav.test.ts src/shell/navigation-preferences.test.ts
```

**342 passed, 0 failed, 2851 assertions.** Product and review-runtime typechecks
pass. Focused model tests include pending Back/resubmission, retained-path outcomes,
coordinated stop/catalog sequencing, metadata enrichment during editing, direct
operation access, all 14/17 diagnostic rows, report Back and secret clearing.

Targeted shared-owner Chromium browser cases passed for full-page geometry,
focus, Back/Forward, centered confirmations and pending-response history. The
first visual runner completed **8 checks in Chromium**, plus **2 initial WebKit
checks** before WebKit's Delete click stalled. A later Chromium-only visual-polish
run completed **9 checks**, capturing four images in `direct-settings/current/`.

The latest attempted recapture failed during `newPage` before any application
checks and generated no new images; its `current/report.json` records that failure
and the attempted intermediate fingerprint. Existing PNGs are retained from the
previous successful capture, not falsely attributed to the failed run. Since that
successful capture, only report-Back behavior/copy and ordinary startup-choice
presentation changed; the pictured Settings layout is unchanged.

**Current full Chromium/WebKit integration and physical iOS keyboard/VoiceOver
verification remain incomplete.** Task 11.4 and previous matrix/evidence gates
remain open. Do not inherit a prior full-suite pass or promote these captures to
approved goldens.

## Review

Reload <[PRIVATE_REVIEW_ORIGIN_REDACTED]/>. Check a credential's
direct actions, unlocking, a preference editor, a destructive confirmation, and
explicit Check Results/report navigation. The controller remains separate at
`/review/controller`; simulation login is **reviewer / review-only**. Never enter
real secrets. Approval remains pending for this exact served version.

> Privacy redaction: concrete private review endpoints have been removed; the placeholders above are not live URLs. Historical measurements and outcomes are unchanged.
