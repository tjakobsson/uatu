## 1. Reproduce and pace burst delivery

- [x] 1.1 Add and run a bounded real broker/endpoint test with 2,713 small conversation events in one chunk; capture its unexpected stream closure before fixing.
- [x] 1.2 Pace shared upstream batches without changing queue limits; verify the reading-client test passes and existing stalled-client tests still pass.
- [x] 1.3 Cover and pace private catch-up replay; verify every replay cursor arrives in order and merges into live delivery.
- [x] 1.4 Guard teardown during pacing; verify released/superseded owners receive no remainder of an in-progress batch.

## 2. Verify and hand off

- [x] 2.1 Run broker, endpoint, client, lifecycle and live-channel tests plus typecheck; record exact checks and validate this OpenSpec change strictly.
- [x] 2.2 Record the red/green evidence, changed paths and live-attribution limits for independent lead review; do not publish or mutate live sessions.
