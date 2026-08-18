## 1. Drill-down state

- [x] 1.1 In `src/chat/ui.ts`, replace `openChildConversation`'s picker-option injection with an explicit drill-down state (viewing child X of parent Y) that leaves the picker's selection on the parent
- [x] 1.2 Render the child transcript from that state without routing it through the conversation inventory; keep the parent's projection, composer, and pending requests mounted
- [x] 1.3 Remove the flush-save special-case that protected the injected picker option's draft
- [x] 1.4 Stop appending children to the picker anywhere

## 2. Return affordance and the two chromes

- [x] 2.1 Add a first-class back affordance that returns to the parent without re-selecting it, in `src/index.html`
- [x] 2.2 In `src/styles.css`, render the drill-down inline over the timeline on the desktop split, keeping the parent in view
- [x] 2.3 In `src/styles.css`, render it as a pushed screen in touch mode, with the platform back gesture returning to the parent; confirm it composes with the touch tab bar
- [x] 2.4 Confirm returning restores the parent at its live position

## 3. Parent stays answerable

- [x] 3.1 Confirm a pending request owned by the parent (or a subagent) remains reachable and answerable while a child is open
- [x] 3.2 Confirm a subagent's request still resolves in both places, unchanged from today

## 4. Tests and verification

- [x] 4.1 Cover it in the chat e2e: opening a subagent drills down, the picker still shows the parent, back returns to the parent, and no subagent appears in the picker
- [x] 4.2 Run the app at desktop split and touch widths; open a subagent, answer a parent request behind it, return
- [x] 4.3 Run `bun test`, then `bun test:e2e`
