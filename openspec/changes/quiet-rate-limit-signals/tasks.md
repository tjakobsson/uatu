## 1. Make the standing one item

- [x] 1.1 Mint the rate-limit standing as the singleton `notice:rate-limit`, upserted as the standing changes with `createdAt` at its onset; verify repeated events at one standing yield a single item whose id and onset do not move, and that a changed level updates it in place.
- [x] 1.2 Retire a cleared standing with a `remove` update instead of the `rate-limit-cleared` notice; verify the item is gone from the projection after a clearing event, and that a clear arriving with no standing in force changes nothing.
- [x] 1.3 Simplify `latestRateLimit` to find the standing by its id rather than scanning the tail for a code prefix; verify the existing composer-status cases still hold, including no standing and a standing followed by a clear.

## 2. Take the standing out of the timeline

- [x] 2.1 Filter rate-limit notices out of the rendered items beside the existing `context_report` predicate, commented against that precedent; verify a warning and a rejection each render no row while a `refusal-fallback` notice still does.
- [x] 2.2 Verify grouping is unaffected: a filtered standing sitting between two tool calls does not split a finished run's activity group.

## 3. Fold the badge into the plan chip

- [x] 3.1 Resolve the chip's label and level from the plan report and the standing together, in the order design.md sets out; verify each case — rejection, plan with a warning standing, standing without plan windows, cost-only, nothing — yields the expected words and level.
- [x] 3.2 Show the chip when a standing exists but the login reports no plan; verify it appears and opens, where today no chip is shown at all.
- [x] 3.3 State the standing in the readout above the window rows, with its message and reset; verify it reads correctly both alongside plan rows and as the readout's only content.
- [x] 3.4 Remove `#chat-rate-limit`, its CSS rules, and the chips-hidden condition that referenced it; verify no rule or query survives for the removed element and the chip row still hides when there is nothing to show.
- [x] 3.5 Announce a standing that begins, changes level, or is retired through a visually-hidden `role="status"` region separate from the composer's routine status; verify the announcement fires on each transition and that the routine state's own announcements are unchanged.

## 4. Update the contract

- [x] 4.1 Rewrite the `notice` schema's `code` description to say these codes are composer data that is not rendered as a timeline row, and drop `rate-limit-cleared`; verify `bun run api:lint` passes.
- [x] 4.2 Bump the workspace revision across `api/contract.json`, `api/openapi.yaml` (version, summary, `x-uatu-revisions`) and `src/shared/version.ts`, with an `api/CHANGELOG.md` section carrying a Migration paragraph in revision 12's shape; verify CI's compatibility step run locally reports the bump as expected rather than as a break.

## 5. Verify the behavior in the app

- [x] 5.1 Add a browser regression driving a warning, a rejection, and a clear: assert no timeline row appears for any of them, the chip's words and level at each standing, and the readout's standing line; verify it covers both the plan-reporting and no-plan logins.
- [x] 5.2 Reopen the surface in the real app in touch and desktop mode at a warning and at a rejection, and save the shots under `openspec/changes/quiet-rate-limit-signals/screenshots/`.
