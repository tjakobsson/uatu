## 1. Mode: rename what is already there

- [x] 1.1 Rename `ChatAgent` to `ChatMode` in `src/chat/types.ts` and correct its comment — it describes a way of working, not a program
- [x] 1.2 Follow the rename through `src/chat/provider.ts`, `src/chat/sdk-v2-provider.ts`, `src/chat/adapter.ts`, and `src/chat/service.ts`; `listAgents` becomes the mode listing
- [x] 1.3 Rename the route `/api/chat/agents` to `/api/chat/modes` in `src/server/chat-routes.ts` and `src/server/routes.ts`
- [x] 1.4 Rename `#chat-agent-select` to `#chat-mode-select` in `src/index.html`, `src/chat/ui.ts`, and `tests/e2e/chat.e2e.ts`, and relabel the control as the mode
- [x] 1.5 Run `bun test` — this step is a pure rename and must be green before the new meaning is introduced

## 2. Agent: the new meaning

- [x] 2.1 Add the agent descriptor to `src/chat/types.ts` — the agent's identity and its declared capabilities — reusing the now-free `ChatAgent` name
- [x] 2.2 Have the provider report its identity in `src/chat/sdk-v2-provider.ts`, and carry it through `src/chat/service.ts` onto the `ready` availability state
- [x] 2.3 Declare the capabilities Chat already has: modes, model selection, commands, questions, permissions, subagents. Declare nothing else — a later change adds its own key with its feature

## 3. The surface speaks the vocabulary

- [x] 3.1 Replace the fixed agent name in `src/index.html` and `src/chat/ui.ts` — "Ask OpenCode…", "Message OpenCode", "OpenCode Chat", "Loading OpenCode…", "Starting OpenCode…", "Question from OpenCode" — with the name the agent reports
- [x] 3.2 Name the agent in the chat header, so the surface states what it is talking to
- [x] 3.3 Gate each control on its declared capability, and make the absent case remove the control rather than disable it
- [x] 3.4 Confirm the startup and unavailable states still read correctly when no agent has reported a name yet

## 4. Tests

- [x] 4.1 Cover the absent-capability path in `src/chat/ui.test.ts` or its nearest sibling, against a provider that declares less than OpenCode — assert the control is absent, not disabled
- [x] 4.2 Cover the agent descriptor through `src/chat/service.test.ts` and `src/server/chat-routes.test.ts`
- [x] 4.3 Update `tests/e2e/chat.e2e.ts` for the mode select and the named agent

## 5. Contract and documentation

- [x] 5.1 Rename the route and its operation in `api/openapi.yaml`, and widen the `ready` arm of `ChatAvailability` with the agent descriptor
- [x] 5.2 Bump `workspaceApiRevision` 3 → 4 in `api/contract.json` and `api/openapi.yaml`
- [x] 5.3 Add the `api/CHANGELOG.md` migration section naming the workspace domain, the route rename, and the widened ready state
- [x] 5.4 Correct the vocabulary in `docs/OPENCODE-CHAT.md`, including the line stating the integration is OpenCode-only — it becomes a statement about the only agent currently declared

## 6. Finish

- [x] 6.1 Run the app and read the surface end to end; confirm no user-visible string names an agent that did not report itself
- [x] 6.2 Run `bun test`, then `bun test:e2e`
- [x] 6.3 Open the PR as `feat(chat)` — this is new user-visible behavior on unreleased work, so no Release Please override is needed
