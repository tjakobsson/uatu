# Screenshots

Evidence for this change, so review does not need a manual session. Every
shot comes from a fixture-driven Playwright run (`chat-claude-polish.e2e.ts`,
plus a throwaway baseline spec for the before shots). Desktop is 1400x1000;
phone is 390x844 in touch mode.

Before:

- `before-plan-chip-desktop.png` shows the old "Plan 9% of 5h · 25% of 7d"
  chip under the composer, hovered. The OS draws the native `title` tooltip
  ("5-hour window resets 14:00") outside the page, so it does not paint into
  a screenshot. The chip is what the reader saw.
- `before-plan-chip-phone.png` is the same chip at phone width.
- `before-panels-menu.png` is the sidebar panels menu without a Usage pane.

After:

- `after-plan-chip-desktop.png` shows "Session 9% · Week 25%" in the same
  spot.
- `after-plan-readout-desktop.png` has the readout open. Max plan, every
  window with its meter and reset, extra usage, this conversation's cost and
  per-model totals, and the "Keep in sidebar" pin at the top right.
- `after-plan-readout-warning-desktop.png` has the Fable bucket at 83%. The
  chip and the row take the warning colour.
- `after-usage-pane-desktop.png` is taken after the pin. The Usage pane sits
  in the sidebar with the same rows and the report's time, and the pin is
  gone from the readout.
- `after-plan-readout-phone.png` shows the readout at phone width. It spans
  the composer and offers no pin, because the sidebar is the Files tab there.
- `after-cost-chip-readout-desktop.png` is an API-key login: no plan windows,
  so the chip reads "$1.23 this conversation" and the open readout is the
  "This conversation" block alone, with no plan name, meters, or pin.

Each filename says what it demonstrates. A task is not done until its
screenshot is here.
