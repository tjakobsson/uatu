## Why

A long transcript is mostly tool calls, and Chat renders each tool's output as
a `<details>` that is collapsed by default, holding the whole output in one
`<pre>`. There is no truncation anywhere in the renderer — the choice is all or
nothing, and the default is nothing. OpenCode does the opposite: it streams a
tool's output while it runs (`session.next.tool.progress` carries `content`)
and shows the tail, then collapses it behind a count when the tool finishes.
Chat receives that progress event and today keeps only the final state.

So a running command gives no sign of what it is doing, and a finished one
either hides everything or, expanded, dumps hundreds of lines with no floor or
ceiling.

## What Changes

- **Show a running tool's output as it streams** — the tail, live, the way
  OpenCode's own client does — from the `session.next.tool.progress` content
  the workspace already receives and currently discards.
- **Bound a finished tool's output with a show-more.** A completed tool
  collapses to a summary and a bounded preview; the full output is one action
  away, not the default and not absent.

Explicitly out of scope:

- A live terminal surface. This is the tool-activity row's output, not the
  embedded terminal.
- Changing which tools render or how their summaries read — only their output
  body gains a live tail and a bound.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: the requirement *Chat presents turns as readable
  conversation with inspectable activity* gains that a running tool's output is
  shown as it streams, and that a finished tool's output is bounded with a way
  to see the rest rather than shown whole or hidden whole.

## Impact

**Code**
- `src/chat/normalization.ts` — keep the progress content instead of ignoring
  it; carry a tool's streamed output on its item.
- `src/chat/timeline-renderer.ts` — render the live tail and the bounded
  preview with a show-more.
- `src/chat/types.ts` — the tool item carries its streamed output.
- `src/styles.css` — the tail and the show-more control.

**Published API contract**
- The tool item is `additionalProperties: false`; streamed output on it is
  breaking. `workspaceApiRevision` bump coordinated with the branch's other
  wave-1 changes, with an `api/CHANGELOG.md` section.

**Delivery**
- Unreleased chat work; a `feat(chat)` note is truthful.

**Relationship to other changes**
- Wave 1, on `fix/chat-ui-density`. It owns *presents turns as readable*, so its
  delta collides with none of the siblings. Its bounded-output show-more is what
  `chat-change-review`'s card diff can lean on for large patches.
