## 1. Keep the reported data

- [ ] 1.1 In `src/chat/types.ts`, add `variants` (id list, or `{id,label}`) and `contextLimit` to `ChatModel`; keep model (`providerId`/`modelId`) and token counts (input, output, reasoning, cache read/write) on the normalized assistant item; add a per-subagent usage total to the tool item and `SubagentEntry`; add `variants` and `context` to `ChatCapability`
- [ ] 1.2 In `src/chat/sdk-v2-provider.ts`, have `listModels` keep each model's `variants` and `limit.context`, and `describe()` declare `variants` and `context`
- [ ] 1.3 In `src/chat/normalization.ts`, stop discarding `modelID`/`providerID` and `tokens` from assistant messages
- [ ] 1.4 In `src/chat/validation.ts` and `src/chat/client.ts`, parse the widened model and the assistant usage
- [ ] 1.5 Cover the plumbing in `normalization.test.ts` and `sdk-v2-provider.test.ts`: usage survives normalization, variants and the context limit survive model listing

## 2. Reasoning-variant control

- [ ] 2.1 In `src/index.html`, add the variant select beside the model select, labelled and hidden by default
- [ ] 2.2 In `src/chat/ui.ts`, populate it from the selected model's variants, remember the choice per conversation like the model, and send it as `variant` on the prompt; gate it on `declares("variants")` and remove it when undeclared
- [ ] 2.3 Thread `variant` through `src/chat/client.ts`, `src/chat/service.ts`, `src/chat/adapter.ts`, and `src/chat/sdk-v2-provider.ts` prompt paths, refusing a variant the selected model does not offer
- [ ] 2.4 Cover it: a variant is sent with the prompt, remembered, and refused when unknown; the control is absent for a model without variants

## 3. Context-usage indicator

- [ ] 3.1 In `src/chat/ui.ts`, derive the conversation's context fill from the latest assistant item's usage against the selected model's `contextLimit`
- [ ] 3.2 In `src/index.html` and `src/styles.css`, render it in the composer row — collapsed to a legible bar, expandable to the input/cache/output breakdown; gate on `declares("context")`
- [ ] 3.3 Keep it subtle: it reads at the chat scale and does not shout over the composer
- [ ] 3.4 Cover it: the collapsed form conveys the fill, the expanded form shows the breakdown, and the indicator is absent when `context` is undeclared

## 4. Subagent attribution

- [ ] 4.1 In `src/chat/adapter.ts`, sum a child session's assistant usage and mirror the total onto the parent's projection on the existing coalesced update path — the one that already carries a child's pending requests
- [ ] 4.2 In `src/chat/timeline-renderer.ts`, extend `SubagentEntry` and the subagent row body with the model and token total
- [ ] 4.3 In `src/chat/ui.ts` and `src/styles.css`, render the attribution on the row, gating the token figure on `declares("context")`; keep the description truncating rather than the numbers
- [ ] 4.4 Handle absent usage: name the subagent and its status, assert no figure
- [ ] 4.5 Cover both cases in `adapter.test.ts` and `timeline-renderer.test.ts`

## 5. Contract and delivery

- [ ] 5.1 In `api/openapi.yaml`, widen `ChatModel` with variants and the context limit, the assistant/tool items with usage, and `ChatPromptRequest` with `variant`; add `variants` and `context` to the `ChatAgent` capability description
- [ ] 5.2 Bump `workspaceApiRevision` 4 → 5 in `api/contract.json`, `api/openapi.yaml` (including `info.version`/`info.summary`), and `src/shared/version.ts`
- [ ] 5.3 Add the `api/CHANGELOG.md` migration section naming the workspace domain and the new fields
- [ ] 5.4 Run the app and read a conversation with subagents and several turns; confirm the variant control, the context indicator, and the subagent attribution at desktop split, and that each is absent when its capability is not declared
- [ ] 5.5 Run `bun test`, then `bun test:e2e`
