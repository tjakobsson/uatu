## Why

The Chat panel reads as one undifferentiated field, set at the document
preview's type scale. Two defects follow.

**The type is sized for prose, not for a conversation.** Chat inherits the
preview's reading scale, so a narrow side panel shows a handful of lines of a
transcript whose value is in seeing several turns at once. And the scale is not
currently ours to set: `body` declares no size, so Chat runs at the browser's
16px root, and an assistant message renders into `.markdown-body`, which the
vendored `github-markdown-css` pins at an absolute `font-size: 16px`.

**The pinned tracks sit on the same surface as everything else.** The todo list
and the subagent track both use `--surface-raised`, the same tier as the
timeline cards above them. They are the one place that answers "where are we
now", and nothing about the panel says to look there. Re-pointing them at
`--surface-subtle` would not fix it either: under the dark scheme
`--surface-raised`, `--surface-subtle`, and `--surface-muted` all resolve to
`#161b22`.

## What Changes

- **Set Chat's own type scale**, denser than the preview's, declared on the
  chat surface so every descendant inherits it — including the vendored
  Markdown, which needs an explicit override to stop sitting at 16px.
- **Give the pinned tracks their own visual tier**, distinct from the timeline
  cards in both colour schemes, so the panel has somewhere for the eye to land
  without shouting.

Explicitly out of scope:

- Retuning spacing, radius, or colour anywhere else in Chat. Density here means
  type scale and the tracks' tier. A general visual redesign is not this.
- A user-facing Chat text-size control.
- Touching `.markdown-body` outside the chat surface. The preview's reading
  scale is deliberate and stays.

Two items this change originally carried have moved, because both collided:

- **Compacting a resolved permission card** moved to `chat-change-review`. Both
  rewrite `renderPermission`, and both would write a delta against *Users can
  resolve agent interaction requests in context*. One change owns that
  requirement.
- **Subagent model and token attribution** moved to `chat-agent-capabilities`.
  It needs the token plumbing that change builds, so it cannot land first.

What remains touches one file. That is what makes it safe to run beside the
other changes and safe to land last.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: adds one requirement. Nothing in the capability today says
  anything about the surface's reading density or its visual tiers — the
  existing requirements describe what Chat shows and how it behaves, never how
  densely it reads. A new requirement states that Chat sets a reading density
  of its own rather than inheriting the document preview's, and that the pinned
  progress tracks are distinguishable from the transcript by something other
  than colour alone.

## Impact

**Code**
- `src/styles.css` — the chat type scale, the `rem` to `em` conversion inside
  the chat block, the scoped `.markdown-body` override, and the tracks' surface
  tier token.

No TypeScript, no markup, no transported data. This change adds no field to any
schema, so it needs **no API revision bump**.

**Relationship to other changes**
- Wave 1, alongside `chat-agent-capabilities`, `chat-subagent-navigation`,
  `chat-activity-output`, and `chat-change-review`. It is written against the
  vocabulary `chat-agent-vocabulary` establishes.
- It is the only one of the five that rewrites the chat block of
  `src/styles.css` wholesale, and the other four each touch that file lightly.
  Landing it last avoids four textual conflicts; landing it first means landing
  it fast.

**Delivery**
- Chat is entirely unreleased — every `src/chat` commit postdates `v0.5.1`.
  This corrects unreleased presentation, so a `fix(chat)` PR needs the
  `BEGIN_COMMIT_OVERRIDE` block before squash merge.
