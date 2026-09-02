# Screenshots

Evidence for this change, so review does not need a manual session.

- `before-*` — the 2026-09-02 audit (Claude Code 2.1.258): a Haiku turn in a
  scratch workspace driven by Playwright, plus two phone captures of a real
  Opus 1M conversation. These are the states the tasks fix.
- `reference-*` — what the Claude apps show; the target for "More models".
- `phase1-*`, `phase2-*`, `phase3-*` — added by the tasks as each lands,
  captured from the same scripted run (desktop 1400x1000 and a phone-width
  viewport) so before/after pairs line up.

- `phase1-real-haiku-*`, `phase2-wakeup-*` — real Haiku turns in a scratch
  workspace driven by Playwright while each phase landed (desktop 1400x1000).
- `phase2-spike-d9-output.txt` — the scripted SDK run that decided D9: the
  CLI starts the follow-up turn itself after a background task settles.
- `final-desktop-*`, `final-phone-*` — the closing acceptance run of the
  2026-09-02 audit prompt (hello.sh, ls, read, backgrounded sleep, date) on
  Haiku, at desktop width and at phone width (390x844, touch mode): picker,
  background state, the CLI's own follow-up turn, the expanded meter with
  the session's categories and plan utilization, and the expanded rows.

Each screenshot's filename says what it demonstrates; a task is not done until
its screenshot is here.
