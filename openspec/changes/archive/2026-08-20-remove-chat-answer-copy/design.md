## Context

Completed assistant messages are decorated with both a whole-answer copy control and per-code-block controls. The controls share clipboard feedback behavior, but whole-answer copy additionally depends on conversation projection data and message-level action markup. See `proposal.md` for the UX decision and the delta spec for retained behavior.

## Goals / Non-Goals

**Goals:**

- Remove all whole-answer copy presentation and behavior.
- Preserve code-block copy scope, accessibility, touch reachability, and fixed-geometry feedback.
- Leave the shared clipboard utility available to Chat and Preview.

**Non-Goals:**

- Changing Preview code-block copy or clipboard fallback behavior.
- Adding copy actions to user messages, conversations, tools, or activity rows.
- Redesigning assistant-message or code-block presentation.

## Decisions

### D1: Narrow assistant decoration to completed code blocks

Keep the existing idempotent decoration pass and completion gate, but have it create controls only for fenced `pre > code` content. Remove the message-level action container and answer-specific control rather than hiding them with CSS, so they are absent from keyboard navigation and accessibility trees.

Retaining the decorator avoids changing streaming lifecycle behavior. Rebuilding the entire decoration path would add risk without improving the remaining code-copy interaction.

### D2: Narrow delegated copy handling to code text

Resolve copy text only from the control's owning `pre > code`. Remove the whole-answer branch that reads normalized Markdown from the conversation projection. Keep delegated event handling because transcript items are incrementally patched and rendered in both parent and drill-down timelines.

### D3: Keep shared feedback behavior but remove answer-specific assumptions

Retain the bounded success/failure state, live-region announcement, and shared clipboard writer. Remove answer-specific labels and styles while preserving code-copy labels, fixed footprint, fine-pointer reveal, and coarse-pointer sizing.

## Risks / Trade-offs

- [Removing shared selectors accidentally changes code-copy presentation] -> Separate answer-only selectors from shared and code-specific selectors, then retain focused geometry and touch tests.
- [Streaming completion duplicates code controls] -> Preserve idempotent per-block detection and test repeated decoration.
- [Whole-answer behavior remains through stale tests or branches] -> Assert that completed assistant messages contain no `data-chat-copy="answer"` control while code controls remain functional.

## Migration Plan

No data or API migration is required. Remove the whole-answer contract and implementation in one release while retaining code-copy behavior. Rollback can restore answer decoration without changing conversation state or clipboard storage.
