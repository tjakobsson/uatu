# Isolated UI suite: measured aggregate budget

## Cause

The UI wrapper's 60-second cap covers an entire isolated child suite, not one
test. In [run 41611072260](https://github.com/tjakobsson/uatu/actions/runs/41611072260/job/125832880521),
the wrapper failed at 60,001.38 ms after **169 child passes totaling 59,759.27 ms**.
Source order and the existing local named-test report confirm **17 cases remained**
out of 186. There was no child completion summary before the timeout.

An earlier [CI wrapper pass](https://github.com/tjakobsson/uatu/actions/runs/41606357013/job/125817126171)
took 59,392.88 ms, leaving only 607.12 ms of headroom. Together these observations
attribute the current timeout to an insufficient aggregate allowance during test
execution, not a completed child stuck in shutdown. Why Linux takes longer than
local macOS is not separately attributed. The earlier 20-minute job hang remains
a distinct unresolved report.

Bun's parallel reporter groups file output. Apparent CI log timestamps must not
be interpreted as individual test start/end times; this accounting uses reported
case durations, source order and the actual parent deadline.

## Narrow adjustment

Increase only the outer wrapper cap from **60 to 75 seconds**. Preserve all 186
test identities, 1,145 assertions, child code, process isolation, spawn arguments,
environment, inherited output and zero-exit assertion. The default five-second
child deadlines and four explicit 15-second child deadlines remain unchanged.
No product, dependency, retry, skip or process-cleanup policy changes.

Sizing is an engineering allowance, not a measured upper confidence bound:

1. Completed CI case work: 59.759 s.
2. The 17 missing cases cost 0.384481 s in the existing local report. Scaling by
   the matched-prefix CI/local ratio projects 0.654 s; a conservative sensitivity
   check using the largest ratio among the last 13 completed cases projects
   1.378 s. These are estimates, not measured Linux suffix times.
3. Use the more conservative 61.138 s projected case total, add a stated 1 s
   process/reporting allowance and 20% scheduling margin:
   `(61.137535 + 1) × 1.20 = 74.565042 s`, rounded to 75 s.

The measured slow cases contain recovery and meaningful no-further-read
observation intervals. Removing them without a demonstrated replacement would
weaken coverage. No evidence currently justifies a 90-second cap.

## Verification and acceptance

Fresh independent Sol review approved this measured sizing proposal for
implementation, not acceptance. The applied diff preserves the child branch
byte-for-byte. On macOS/Bun 1.4.4, the real wrapper passed all 186 child tests and
1,145 assertions, then its parent passed, in 38.869 seconds:

```sh
# Prepend the approved task-local runtime; verify bun --version is 1.4.4.
bun test src/chat/ui.test.ts
```

The first controlled hanging-child check used the actual 75-second cap and a
90-second supervisor watchdog. The runner failed naturally and exited in 75.335 s,
but the child PID still existed immediately afterward. The supervisor killed that
owned PID. Live process versus transient zombie was not captured, so this check
**did not establish natural child cleanup**; it is retained as failed verification.
A subsequent single forensic check registered native process-exit notifications.
The child exited naturally at 75.119 s; the runner exited at 75.123 s with the
expected test-failure exit code. Immediate process-state and signal-zero checks
confirmed both PIDs absent. No grace period, polling, watchdog intervention or
supervisor kill was needed. This establishes finite natural cleanup for that run;
it does not retroactively determine the earlier PID's state or erase the failed
verification. No cleanup code was changed.

The real pre-change Linux failure is the call-site red. Local passing execution
and projections do not supply the Linux green. Acceptance requires the actual
changed wrapper to complete all 186 cases on three first-attempt Linux/Bun 1.4.4
CI validations under four workers, with passing required final-candidate checks.
Retry-assisted test passes, watchdog intervention, missing suffix cases or pending
CI are not accepted as success. No #560 resolution is claimed yet.
