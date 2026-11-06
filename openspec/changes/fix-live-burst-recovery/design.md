## Context

See proposal.md for the observed local failure. `LiveBroker.open` and `catchUp` synchronously iterate all frames returned by one parser push. `ClientStream` has a 1 MiB non-coalescible backlog cap; its pull loop cannot drain while that synchronous iteration runs. Existing tests cover intentional stalls, but not an actively reading client receiving a multi-megabyte batch.

## Goals / Non-Goals

**Goals:** Give outbound readers/I/O turns during long upstream batches while preserving cursor ordering, ownership and the existing stall cap.

**Non-Goals:** Change history normalization, replay retention, dismissal APIs, authentication, the client reconnect policy or infer what happened in the live screenshot.

## Decisions

- Process bounded batches (64 KiB of frame data accumulated across reads), then yield an event-loop turn before continuing. A macrotask yield permits both response pull loops and socket I/O; merely queueing a microtask does not guarantee either has drained. A single large frame is followed by a yield before more frames are sent. The byte budget spans reads because 16 KiB chunks can collectively starve a draining reader too.
- Apply the same pacing to the shared upstream and private catch-up. Retain synchronous per-frame handling and inspect abort/detach ownership before continuing after yields.
- Keep the cap and failure policy unchanged. Raising the cap only moves the failure threshold; coalescing conversation updates would lose cursor predecessors. Adding asynchronous backpressure to every sink would be a larger interface change than this bounded correction.

## Risks / Trade-offs

- [Additional scheduling turns for bulk replay] → Yield by bytes rather than every frame; small ordinary chunks retain their current path.
- [Teardown can now interleave with a child chunk] → Check the current upstream controller or catch-up abort/detach before every subsequent frame, and test cancellation during a burst.
- [Synthetic input is not a live incident trace] → State the limit explicitly; do not claim screenshot attribution. Test the real broker/endpoint with bounded synthetic payloads and retain existing stall tests.

## Migration Plan

No persisted or wire format changes. Deploy with the normal application update; reverting the broker pacing restores the old behavior. No new dependency or service is required.
