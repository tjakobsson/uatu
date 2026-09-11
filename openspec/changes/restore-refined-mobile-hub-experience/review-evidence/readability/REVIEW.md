# Stage 12 — actual PNG readability inspection

## Scope and provenance

Manually opened and read all six final PNGs below, not merely their DOM assertions. These are discovery evidence, **not approved goldens**. Current actual frontend built by `startReviewServer({ port: 0 })`, existing typed synthetic backend callbacks, installed Chromium 153.0.8010.12, one fresh touch/light browser context, **390 × 844 CSS pixels**, scale 1. No screenshot CSS, forced hiding, DOM painting, or private attachments. The only form edits were explicit UI intent: replace the Atlas authentication credential, enter `  GITHUB.COM  `, press Review (never Apply), and enable the clone Start draft (never submit).

Authoritative before checkpoint: **c259efb**. No old-source screenshots were captured; this report does not claim a verified visual before/after comparison. Health fingerprint for these final captures:

`sha256:857194da7554ae77239dc0a12f63df81e1bf3827e34390f2a6742d44c25a4f32`

The synthetic fixture starts with `mixed`, then uses the current typed `assignWorkspace` callback to assign `ssh-open` on `github.com` to Atlas. Production preferences were not read or reset. The new context intentionally has not dismissed the shared-credentials notice. Port 4703 was not used or changed; the temporary server/browser were closed in finally blocks. No product changes, dependencies, commits, or golden updates.

Runner: `tests/mobile-hub-review/readability-capture.browser.ts` (`bun` orchestrates the ephemeral server; Node runs installed Playwright). Final successful capture took **49.232 seconds** excluding the server build. Earlier attempts hit browser startup stalls, stale test selectors, and a click timeout; the whole investigation exceeded 120 seconds. Final results supersede those discovery attempts, not a claim that the first run passed.

## Visual findings

| Actual screenshot | Manual visual result |
| --- | --- |
| [01-settings-fresh.png](01-settings-fresh.png) | **PASS for notice prominence.** Amber, bordered warning is immediately below identity and before credentials. Title/body are legible and explicitly deny isolation. Devices is below this viewport: exactly one entry is verified structurally, not visually shown here. |
| [02-credential-purpose.png](02-credential-purpose.png) | **PASS.** “USED FOR” → “Git access” → “SSH” reads as information, not as a tappable preference. Protection/runtime/public identifier use subdued labels and stronger values; the Copy action is blue. `dt`/`dd` semantics are present. No invented signing purpose for this authentication-only key. |
| [03-workspace-assignment-summary.png](03-workspace-assignment-summary.png) | **PASS, viewport caveat.** Folder/status and Host/Credential are clearly read-only information. “Edit authentication on github.com” is separately blue. The warning remains prominent. Lower Remove/general Edit/Add actions require scrolling and are not evaluated visually in this shot. |
| [04-edit-first-entry.png](04-edit-first-entry.png) | **PASS.** Full-page editor with Cancel/Review, readable workspace facts, populated `github.com`, closed authentication and signing pickers, no focused form control and no visible popup/keyboard. This is browser first-entry evidence, not proof about a physical iOS keyboard. |
| [05-review-changes.png](05-review-changes.png) | **PASS for authentication comparison.** Current unprotected SSH and After applying locked SSH are distinct labeled rows; normalized `github.com` is visible. “Replaced” has both text and a green edge, not color alone. “Apply and replace” fits without collision. Commit signing continues below the viewport; not a full review-page inspection. |
| [06-clone-start-and-empty-host.png](06-clone-start-and-empty-host.png) | **PASS with copy issue.** Naturally scrolled lower clone form shows green enabled Start switch with white thumb on right, and an empty disabled Host field visually differentiated by dashed border/muted fill. Clone identity versus post-setup credentials are clearly separate groups. This is a draft only. |

## Quality flags / remaining gaps

1. **Disabled-host guidance is clipped (minor but real):** at 390 px the placeholder displays “Choose a Git authentication credential…” without the final instruction. The field's accessible description supplies full guidance, but visible copy is not fully readable. Do not mark this perfect on the strength of the disabled-property test.
2. **Bottom navigation and viewport density:** Settings shows partial lower credential/Add content at the floating navigation edge; credential details cut off part of Manage assignments near the content boundary. These captures do not establish that actions are unreachable, but they do show awkward partial rows at rest. Summary actions and full signing review need real scrolling. No product changes or forced screenshot cleanup were made.
3. **Readiness is intentionally not implied by assignment:** the proposed credential is explicitly “locked,” while Effect uses green for a replacement. Treat this as change-state styling, not successful authentication; no readiness certification follows from this screen.
4. **Single Devices entry is DOM-verified only** in this six-shot set. No Devices-row PNG, dark captures, physical devices, Dynamic Type, VoiceOver, keyboard matrix, or complete task matrix were exercised. No Apple certification claim.

## Checks and layout metrics

Final automated supplements: **5 passed, 0 failed** — single Devices entry; credential `dt`/`dd`; no input/select first-entry focus; host normalization plus Current/After applying labels; checked Start draft plus empty disabled Host. Visual judgments above are separate from these checks.

Full per-screen bounding boxes, fonts, colors, focus state and health identity: [capture-report.json](capture-report.json). Example measured values: fresh warning `x=20, y=239.53, width=350, height=174.30`; Settings title 34 px; visible clone select `x=36, width=318, height=44`, approximately 17 px text; Start switch `51 × 31`, background `rgb(52, 199, 89)`. Switch dimensions alone are not a touch-target audit (its label can provide a larger target).

**Disposition:** sampled readability goals pass with the explicit quality flags above; not an unconditional visual sign-off, before/after parity statement, or golden blessing.
