# Direct settings — actual product evidence

Captured 2026-09-10 using `bun tests/mobile-hub-review/direct-settings-review.browser.ts`.
The runner starts its own port-0 server, builds the actual product frontend, resets
the existing synthetic backend to `mixed`, and uses one browser at a time. No
product edits, dependencies, live configuration, provider calls, real keys, PTYs,
commits, or approved goldens were involved. Importing the runner does not launch it.

## Results and limits

| Engine | Version | Checks passed / failed | Actual PNGs | Outcome |
| --- | --- | --- | --- | --- |
| Chromium | 153.0.8010.12 | 8 / 0 | 4 | Completed |
| WebKit | 26.6 | 2 / 0 | 1 | Delete click timed out during native click dispatch; stopped, no retry |

WebKit's remaining six checks are **not run**, not passed. This is not a clean
cross-engine certification. The target of 2–4 screenshots per engine was met only
for Chromium. No retry-to-green or installation was attempted. A server idle
timeout warning also appeared after the run.

All PNGs are 390×844 CSS pixels, device scale 1, light mode, touch/mobile context,
reduced motion. These are static browser screenshots, **not physical iPhone or
software-keyboard evidence**. No short-viewport/390×664 run was performed.

The credential screenshot deliberately scrolls the genuine page to the action
region: assignments, Public key, Lock SSH key, Check setup, Disable and Delete
are visible together. The page header/top identity fields are outside this
viewport; nothing was hidden or rearranged for the screenshot. These are viewport
shots, not a stitched full credential page. `fullPage` does not automatically
expand a nested scroller. The JSON `defaultText` was sampled while the loading
placeholder was still present and is **not** the settled credential text; the
subsequent awaited assertions and actual PNGs establish the settled state.

Chromium checks establish direct actions, absence of More/details/troubleshooting
and default raw diagnostics, centered Delete alertdialog, request-only Check
Results, 14 diagnostic rows, full-page Unlock header actions and viewport-fitting
passphrase input, and full-page preferences Save/Cancel. All 14 synthetic report
rows are preserved in `report.json`: four binary rows, four version rows, four
runtime rows, credential and capability. Each was scrolled into view and checked
for a nonempty explanatory `small` element. They are fixture results, not actual
host capability checks.

## Manual image inspection / quality flag

All five PNGs were opened and visually inspected.

- Both credential action captures are legible, show the requested direct actions,
  and have no More or troubleshooting disclosure. The dock does not cover Delete.
- The Chromium Delete confirmation is visibly centered, with readable copy and
  distinct Cancel/Delete buttons. Its backdrop is appropriate for confirmation,
  unlike an editor.
- Preferences visibly fills the page with plain header Cancel/Save, no drawer,
  grabber, backdrop, or dock. Fields and explanatory copy fit comfortably.
- **Quality concern: Unlock's focused passphrase field has a conspicuous square
  blue focus outline whose bottom extends below the rounded white field card;
  its top crowds the Passphrase label.** This is an obvious visual polish/layout
  issue despite the field fitting within the viewport. No product change was
  made to hide or fix it. The rest of Unlock visibly occupies the full page and
  has header Cancel/Unlock with no modal chrome.

## Provenance

Bun 1.4.2; repository HEAD `0ba1dad3e96dc7ac8a81f8f820a5e0d9488ffd69`.
HEAD alone is not a fingerprint of the concurrent working tree. Lead should
append the final product/source fingerprint; these are review artifacts, not
approved goldens. SHA-256 of the exact executed runner:
`842273aaa0471103eeb152849537a7a28448d288788b490c07d2a3059895abd3`.

PNG SHA-256:

```text
69f739c6c8409bfa2710ed0462ffcae865a8c1f1a7d860f10014c68ebf202ce0 chromium-credential-actions.png
4a37e5a65d40deaff67b753034620e56c2f15c49de106f2d6a15d6b396fd2609 chromium-delete-confirmation.png
e677f24667ebbb87b82a61abce93f5ec1469d9d27ecf31befe83fb717ba85ae3 chromium-preferences-fullpage.png
2da465eeb8e2195a15bfdaff45fa32091dc843dfa26f6c2951d3ad65f5df8f11 chromium-unlock-fullpage.png
daba1c9897493a774d08eb4ca39b54e005c8f01e9187b5cfd7efa88c12ba926a webkit-credential-actions.png
```
