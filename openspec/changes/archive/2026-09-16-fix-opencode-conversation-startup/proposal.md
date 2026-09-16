## Why

After a cold workspace start, Chat can display the remembered OpenCode conversation as selected while leaving its history blank and Send disabled. A deterministic reproduction shows that when the first inventory is empty and the saved conversation arrives later, the UI updates the chooser without ever requesting history or subscribing to the conversation; users must switch conversations to recover.

## What Changes

- Retain a one-shot pending restoration when bootstrap receives an empty conversation list and this client has a saved conversation selection.
- Open that exact conversation through the normal history-and-stream path when a later inventory includes it, restoring its draft and normal composer behavior.
- Consume restoration before loading, and cancel it when the user selects another conversation or commits to creating one, including while creation is still in flight.
- Keep failed history reads on the existing explicit retry path; repeated inventory updates must not trigger duplicate opens or automatic read retries.
- Preserve the bounded per-agent inventory wait, existing immediate bootstrap selection, and ordinary inventory reconciliation for already selected conversations.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: Define deferred restoration of a remembered conversation after an empty startup inventory, including one-shot execution, user-action precedence, and read-failure recovery.

## Impact

- Product changes are expected to stay in `src/chat/ui.ts`: bootstrap selection, inventory reconciliation, and explicit selection/creation ownership.
- Regression coverage belongs in the existing Chat lifecycle and browser inventory tests. The branch already contains a failing reproduction in `src/chat/lifecycle.test.ts`; no product fix is present.
- No API, storage-format, provider, dependency, authentication, or server-timeout changes. The shared UI behavior remains agent-neutral even though OpenCode cold startup exposed the bug.
- Non-goals: automatically opening arbitrary newly discovered conversations, changing nonempty-inventory fallback selection, changing unseen indicators, fixing unrelated backend subscription snapshots, or redesigning Chat startup.
