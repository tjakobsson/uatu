# UI child output: diagnostic milestone, not a timeout fix

This note records the diagnostic change at `b5f889fa`. Subsequent child output
supported a separate [aggregate-budget correction](test-stability-ui-budget.md);
that later change and its acceptance criteria are not part of this milestone.

## Problem observed

The isolated UI wrapper reached its unchanged 60-second deadline in two Linux
CI runs on Bun 1.4.4:

- [Planning-only baseline](https://github.com/tjakobsson/uatu/actions/runs/41570952785/job/125703572975): 60,003.97 ms.
- [Permission-fix candidate](https://github.com/tjakobsson/uatu/actions/runs/41601591120/job/125801457797): 60,003.64 ms.

The wrapper buffered both child streams and displayed them only after stream
completion and child exit. A timeout therefore hid output the child had already
produced. This is an observability gap, not an attributed cause of slow execution.

## Change

Inherit the child's stdout and stderr and await its exit code. The child test
branch, spawn arguments, environment, isolation flag, wrapper identity, exit-code
assertion and 60-second budget remain unchanged. No cleanup or product behavior
is changed.

## Verification and limits

Completed macOS/Bun 1.4.4 observations:

| Observation | Result |
| --- | --- |
| Original wrapper | Passed in 36.089 s; child output remained hidden. |
| Inherited-output wrapper | Child banner visible after 0.236 s while parent remained alive; all 186 child tests and 1,145 assertions passed, then the parent passed after 49.317 s. |
| Controlled child failure through the wrapper pattern | Stdout and stderr labels visible after 0.071 s; exit code 7 failed the parent assertion. |
| Full local suite with the pending diagnostic | UI child passed all 186 tests in 37.47 s. The full suite failed a separate lease-mode fixture; it was not a green candidate run. |

The controlled failure verifies output forwarding and failure propagation; it is
not a reproduction of the UI timeout. Three earlier controlled hanging-child
probes already exited naturally before this change, with each direct child gone
after runner exit. No cleanup defect was established. The first CI run's later
20-minute job cancellation remains unattributed; the second unit job instead
finished in 3m31s.

The actual Linux timeout still needs useful child evidence and an attributable
cause, followed by a failing-before/passing-after regression and repeated
first-attempt CI passes. This diagnostic change does not justify closing #560.
