## 1. Keep the streamed output

- [x] 1.1 In `src/chat/normalization.ts`, keep the `session.next.tool.progress` content on the tool item instead of discarding it between events
- [x] 1.2 In `src/chat/types.ts`, carry a tool's streamed output on its item
- [x] 1.3 Cover it in `normalization.test.ts`: progress content survives onto the tool item and updates in place

## 2. Live tail while running

- [x] 2.1 In `src/chat/timeline-renderer.ts`, render a running tool's output tail from its streamed content, updating the existing entry in place
- [x] 2.2 In `src/styles.css`, style the tail so it reads at the chat scale and does not steal the reading position
- [x] 2.3 Confirm a running tool the user has scrolled past does not pull the viewport back

## 3. Bounded output with show-more

- [x] 3.1 In `src/chat/timeline-renderer.ts`, bound a finished tool's output to a preview with a show-more that reveals the full text; keep the full text, never truncate silently
- [x] 3.2 In `src/styles.css`, style the show-more control
- [x] 3.3 Cover it in `timeline-renderer.test.ts`: a long output is bounded with a show-more, a short one is shown whole

## 4. Contract and delivery

- [x] 4.1 No schema change needed — the streamed content already lands on the existing tool-item `output` field, so there is no new transported field and no revision bump
- [x] 4.2 No revision bump for this change — it is pure client rendering plus a normalization regression test over data already transported
- [x] 4.3 Run the app: watch a running tool stream its tail, and a finished one bound behind show-more
- [x] 4.4 Run `bun test`, then `bun test:e2e`
