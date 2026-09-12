# iOS UX correction — review candidate, full verification pending

> Start with the [current evidence index](README.md) and [current verification](verification.md). Status and generated-artifact paths below are historical at pre-cleanup commit `373ef6350032f6a0f2a91c2037ebafb553bc002f`; they do not assert fresh passes or close pending gates.

2026-09-10. The user requested an all-screen iOS UX review, lower-half access for
frequent commands, and **no duplicate buttons as a reachability workaround**.
The user subsequently chose **“Update review now”**, explicitly permitting
publication with incomplete browser verification recorded. That is not visual
approval, an evidence waiver, or live-backend authorization.

Candidate frontend fingerprint:
`sha256:b3027d2471609dc504b2f73bf91d70dc1c37f4626015853d031f878ff40cb0d6`.

## What changed

- One lower task toolbar owns Back, the contextual primary and More. Existing
  controls are moved rather than copied. Add Workspace, Add Credential, Sign in
  and unavailable Retry also have one lower-screen home.
- Folder browsing is a single compact grouped list. Tap the named folder row to
  browse; its ellipsis exposes contextual management. Task Back returns to its
  caller; filesystem Up is a separate location action. Default/Create picker
  cancellation preserves typed paths, names and configuration drafts.
- Readiness shows the overall result and blockers first. Technical details are
  initially collapsed, with **all 17 original diagnostic results retained** in
  the representative fixture. No tool identity is inferred from anonymous rows.
- Tools and device inventories use named compact rows. Credential actions use
  explicit facts to choose Enable/Unlock/Test, with secondary commands in More.
- Workspace ellipsis goes directly to useful detail, retaining branch, path,
  named assignments, shell state and restart caveats. No information-to-actions
  intermediate screen. Sign out has one Security location.
- Review sheets have one Back to edit rather than equivalent Back and Cancel
  controls. Reviewed clone unlock says **Unlock and continue**; independent
  unlock never starts a job. Cancellation distinguishes **Keep cloning** from
  **Cancel clone**.
- Clone response input/Send stays low and keyboard-aware. Final results update
  existing status/output nodes in place; late completion/cancel responses cannot
  replace their owner or recreate cleared recovery hints.
- Failed subordinate credential facts preserve usable catalog information and
  safe operations. Settings provides contextual catalog Retry. Form errors are
  revealed within the owning scroll area without replacing drafts or stealing
  keyboard focus during typing.
- Chrome measurements reserve actual dock/toolbar/prompt space. The task takes
  priority over the dock when the keyboard or large text needs the room; controls
  restore afterward. Normal list items scroll naturally—commands are not mirrored.

Guidance: [official Apple sources and Uatu API constraints](ios-hig-research.md).
This is a web/PWA adaptation, not native UIKit behavior or Apple certification.
No public API, real credential/clone, provider or PTY integration was added.

## Evidence and exact limits

The 27-screen audit and before/failing-loop evidence are retained under
`tests/mobile-hub-review/evidence/ios-ux-audit.md`. Audit reachability is not a
claim that all 27 screens received human optical approval.

- Current unit command: `bun test src/hub/mobile tests/mobile-hub-review`:
  **253 passed, 0 failed, 2118 assertions**.
- `bun run typecheck` and the review-runtime TypeScript project: **passed**.
- Shared lower-layout tests previously passed **14 Chromium and 14 WebKit**
  cases, including 200% text and simulated visual-keyboard constraints.
- Credential/readiness browser cases passed 4 focused checks; collapsed readiness
  measured **218.48px**, versus **1320.11px** before, retaining all 17 rows.
- The broad migrated scenario run reached **238 pass / 4 fail**. Its clone DOM
  regression was fixed and the exact cancellation race passed both engines.
- The latest focused error suite passed all **3** cases, including long Clone
  Review and import validation revealing the existing alert.
- Latest folder repro: **passed**, six rows in one group, **63.48–81.03px** per
  row rather than **170.61–221.55px**. The following readiness case timed out
  during Playwright **page creation**, before application navigation.
- The subsequent full WebKit attempt did **not complete successfully**. It was
  stopped by the 20-minute outer limit after widespread setup/bootstrap delays.
  This is not superseded by the earlier 172-test pre-correction green result.

Diagnostic findings distinguish two issues:

1. Initial Chat content-visibility placeholders grew by 33.75px before a detour,
   accounting for 210→244 native scroll anchoring. The test now waits for actual
   top-row layout before setting its unchanged exact-pixel baseline. No product
   scroll policy or assertion was relaxed.
2. Prolonged renderer/bootstrap stalls remain unresolved. Browser frame progress
   pauses while direct model reads are fast; some native samples show semaphore
   waits and CoreText work. Socket-close/full-Chromium controls did not establish
   a fix. We have not invented an animation timer to hide an unproven cause.

Thus **task 9.6 full verification remains open**. Physical Safari keyboard,
Dynamic Type and VoiceOver are not certified by these emulated checks.

Selected immutable test captures: `ios-ux/folder-before.png`,
`ios-ux/folder-after.png`, `ios-ux/readiness-before.png`, with hashes/provenance in
`ios-ux/captures.json`. There is no fresh readiness-after capture claimed. Older
`visual/corrected` and `visual/review-ready` images document earlier versions,
not this new action placement.

## Review this version

Private review access details have been removed; see `handoff.md` for local-only access.
Refresh the locally started reviewer after the
isolated restart. Simulation login remains **reviewer / review-only**; never
enter personal secrets. Existing Hub/test/reference endpoints remain unchanged.

Please review folder traversal/Back, a locked credential and Technical details,
tool options, Default Folder browsing, a long-form validation error, and Clone
review/unlock/cancellation. Report awkward wording, inaccessible controls or
unexpected navigation. No visual/interaction approval is recorded yet.
