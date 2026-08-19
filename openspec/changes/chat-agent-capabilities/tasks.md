## 1. Model data carries variants

- [x] 1.1 `ChatModel` gains `variants` and `contextLimit`; `ChatCapability` gains `variants` (src/chat/types.ts)
- [x] 1.2 `listModels` keeps each model's variant ids (from OpenCode's keyed map) and context limit; `describe()` declares `variants` (src/chat/sdk-v2-provider.ts)
- [x] 1.3 `parseChatModel` accepts the new fields (src/chat/validation.ts)

## 2. Reasoning-variant control

- [x] 2.1 The variant select beside the model select, hidden by default (src/index.html)
- [x] 2.2 Populate it from the selected model's variants, remember the choice per conversation like the model, gate on `declares("variants")`, and hide it for a model without variants (src/chat/ui.ts)
- [x] 2.3 Thread `variant` through client → route → service → adapter → provider, refusing a variant the selected model does not offer (InvalidVariantSelectionError); apply it via the classic body and the v2 switchModel ModelRef
- [x] 2.4 Cover it: variant sent and remembered, refused when unknown, control absent for a model without variants and when the capability is undeclared

## 3. Contract and delivery

- [x] 3.1 `ChatModel` gains `variants`/`contextLimit` and `ChatPromptRequest` gains `variant` in `api/openapi.yaml`; `variants` added to the `ChatAgent` capability description
- [x] 3.2 No revision bump — the fields land under the existing revision 5; extend the `api/CHANGELOG.md` Workspace 5 section
- [x] 3.3 Verify live: real models expose variants; the control appears and sends the chosen variant
- [x] 3.4 Run `bun test`, then `bun test:e2e`

## Deferred to `chat-context-usage`

- Context-window usage indicator and subagent model/token attribution — they share the message-level token-usage seam and declare the `context` capability, split out so this change ships a coherent variant-only unit.
