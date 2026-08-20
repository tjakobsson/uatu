## 1. Chat type scale

- [x] 1.1 Declare the chat reading scale on `.chat-surface` in `src/styles.css`, with a comment stating why it lives there — it is what the desktop split, touch mode, and WebView zoom all compose against
- [x] 1.2 Convert the chat block's `rem` font sizes to `em` so they scale with the surface, checking the nesting as you go (`.chat-activity summary` and its descendants are the deepest case)
- [x] 1.3 Override `.markdown-body` inside the chat surface only, so assistant Markdown stops sitting at the vendored absolute 16px; leave `.markdown-body` outside Chat untouched
- [x] 1.4 Confirm the document preview's own reading scale is unchanged

## 2. Pinned tracks get their own tier

- [x] 2.1 Add the tracks' surface token to `:root` in `src/styles.css` as a `light-dark()` pair that differs from `--surface-raised` in both schemes
- [x] 2.2 Apply it to `.chat-task-list`, which covers both the todo list and the subagent track
- [x] 2.3 Confirm the non-colour cue survives: the tracks stay pinned, bordered, and behind a disclosure caret in forced-colours mode

## 3. Verify against the running app

- [x] 3.1 Run the app and read a real conversation at desktop split, collapsed split, and touch widths; correct anything the numbers got wrong
- [x] 3.2 Check the tier in light, dark, and greyscale
- [x] 3.3 Confirm the change touched `src/styles.css` and nothing else — no TypeScript, no markup, no schema, so no API revision bump

## 4. Finish

- [x] 4.1 Run `bun test`, then `bun test:e2e`
- [x] 4.2 Open the PR with the `BEGIN_COMMIT_OVERRIDE` block — this corrects unreleased presentation, not a stable regression
