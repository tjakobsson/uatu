## 1. Keep the streamed output

- [ ] 1.1 In `src/chat/normalization.ts`, keep the `session.next.tool.progress` content on the tool item instead of discarding it between events
- [ ] 1.2 In `src/chat/types.ts`, carry a tool's streamed output on its item
- [ ] 1.3 Cover it in `normalization.test.ts`: progress content survives onto the tool item and updates in place

## 2. Live tail while running

- [ ] 2.1 In `src/chat/timeline-renderer.ts`, render a running tool's output tail from its streamed content, updating the existing entry in place
- [ ] 2.2 In `src/styles.css`, style the tail so it reads at the chat scale and does not steal the reading position
- [ ] 2.3 Confirm a running tool the user has scrolled past does not pull the viewport back

## 3. Bounded output with show-more

- [ ] 3.1 In `src/chat/timeline-renderer.ts`, bound a finished tool's output to a preview with a show-more that reveals the full text; keep the full text, never truncate silently
- [ ] 3.2 In `src/styles.css`, style the show-more control
- [ ] 3.3 Cover it in `timeline-renderer.test.ts`: a long output is bounded with a show-more, a short one is shown whole

## 4. Contract and delivery

- [ ] 4.1 In `api/openapi.yaml`, add the streamed-output field to the tool item schema
- [ ] 4.2 Coordinate the `workspaceApiRevision` bump with the branch's other wave-1 changes, and add the `api/CHANGELOG.md` section
- [ ] 4.3 Run the app: watch a running tool stream its tail, and a finished one bound behind show-more
- [ ] 4.4 Run `bun test`, then `bun test:e2e`
