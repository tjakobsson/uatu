## 1. Keep token usage on the items

- [ ] 1.1 Add `TokenUsage` to `src/chat/types.ts`; `usage?` on `AssistantMessageItem`; `usage?` and `model?` on `ToolItem`; `context` to `ChatCapability`
- [ ] 1.2 In `src/chat/normalization.ts`, add a `tokensToUsage` helper and attach usage/model to the last assistant part in `normalizeStoredMessage`/`normalizeAssistant` (history path)
- [ ] 1.3 Add the `messageId → last assistant part id` map (threaded like `messageRoles`), populate it in the `message.part.updated` text branch, and on `message.updated` with tokens emit a usage upsert against that part id — never a stray empty bubble
- [ ] 1.4 Buffer a `message.updated` that arrives before any text part; flush when the first part appears
- [ ] 1.5 In `src/chat/adapter.ts` `mergeInteraction` and the client projection merge, preserve streamed markdown when a usage-only upsert arrives (`markdown: incoming.markdown || current.markdown`, merge usage)
- [ ] 1.6 Parse `usage`/`model` in `src/chat/validation.ts` (a shared `expectTokenUsage`); cover the closed-schema guard in `validation.test.ts`
- [ ] 1.7 Cover the normalization paths in `normalization.test.ts`: history usage on the last part, live `message.updated` attaches without a stray bubble or lost markdown, early-arrival buffering

## 2. Context-usage indicator

- [ ] 2.1 Add the readout to the composer row in `src/index.html` and style it in `src/styles.css` — collapsed bar, expandable breakdown
- [ ] 2.2 In `src/chat/ui.ts`, `syncContextIndicator()` (called from `renderNow`) reads the latest assistant item with usage and the selected model's `contextLimit`; fill = input + cacheRead + cacheWrite over the limit
- [ ] 2.3 Gate on `declares("context")` in `applyCapabilities`; declare `context` in `describe()` (`src/chat/sdk-v2-provider.ts`)
- [ ] 2.4 Cover it: the collapsed form conveys the fill, the expanded form shows the breakdown, it populates on opening an existing conversation, and it is absent when `context` is undeclared

## 3. Subagent attribution

- [ ] 3.1 In `src/chat/adapter.ts`, add per-child `usage`/`model` maps, aggregate a child session's assistant usage in the pump, and mirror onto the parent's `task` tool item (matched by `childConversationId`); evict the maps with the projection LRU
- [ ] 3.2 Extend the `tool` case of `mergeInteraction` to carry `model`/`usage`
- [ ] 3.3 In `src/chat/timeline-renderer.ts`, `SubagentEntry` and `subagentEntries` carry `model`/`usage` from the tool item
- [ ] 3.4 In `src/chat/ui.ts` `syncSubagents`, render the model whenever known and the token figure only when `declares("context")`; keep the description truncating
- [ ] 3.5 Cover it in `adapter.test.ts` (aggregation + mirror + absent-stays-readable + LRU eviction) and `timeline-renderer.test.ts` (row renders model always, tokens when present)

## 4. Contract and delivery

- [ ] 4.1 In `api/openapi.yaml`, add `usage` to the assistant and tool `ConversationItem` members and `model` to the tool member; add `context` to the `ChatAgent` capability description
- [ ] 4.2 No revision bump — extend the existing `api/CHANGELOG.md` Workspace 5 section; confirm `src/server/routes.ts` needs no change
- [ ] 4.3 Add `context` to the e2e fake's capabilities and let it inject assistant/tool items with usage (`tests/e2e/chat-service.ts`)
- [ ] 4.4 Verify live against OpenCode: the indicator populates on open and refines during a turn; a real subagent row shows model and tokens; check the `message.updated`↔part ordering risk
- [ ] 4.5 Run `bun test`, then `bun test:e2e`
