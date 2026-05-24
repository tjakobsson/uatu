## Context

`src/styles.css` currently hardcodes monospace font stacks in at least seven places (`build-badge`, `burden-meter strong`, `metadata-card-row-extra .metadata-card-label`, `score-preview h1/h2`, the change-overview file paths, the diff-fallback `<pre>`, etc.), plus the rendered-Markdown code blocks that come from `github-markdown-css`'s `.markdown-body pre code` and friends. The terminal already has its own variable, `--terminal-font-family`, which after `bundle-nerd-font` points at the bundled Hack Nerd Font Mono.

There's already a *placeholder* `--mono-font` reference on the diff fallback (`src/styles.css:3134`): `font-family: var(--mono-font, ui-monospace, SFMono-Regular, Menlo, monospace);`. The variable was never defined. We can fill that gap with a properly named variable that the rest of the app uses too.

`.uatu.json` already has three independent loaders (`terminal/config.ts`, `sidebar/tree-config.ts`, `review/load.ts`), all reading the same file but parsing different top-level keys. The pattern is well-trodden: add a fourth loader for the new `mono` block.

Cross-platform considerations carry from `bundle-nerd-font`: the bundled face is served via `@font-face` from a path Bun's CSS bundler can resolve at build time. Expanding which surfaces resolve to that face is purely a CSS-variable change.

## Goals / Non-Goals

**Goals:**

- One variable, `--mono-font-family`, that governs every monospace surface in the app, with the bundled Hack Nerd Font Mono as the default.
- One `.uatu.json` knob, `mono.fontFamily`, that overrides the default for every monospace surface at once.
- Preserve `terminal.fontFamily` semantics — it still overrides the terminal, and it wins over `mono.fontFamily` inside the panel.
- Win on CSS specificity against `github-markdown-css` so rendered-Markdown code blocks pick up the variable without `!important`.

**Non-Goals:**

- Per-surface knobs (e.g., separate `code.fontFamily` for Markdown code blocks vs `diff.fontFamily` for diff view). One knob keeps the spec small and matches what users actually ask for in practice.
- Replacing `github-markdown-css` or `highlight.js`. Their stylesheets stay; we add targeted overrides for the font-family property only.
- Replacing the body sans-serif (`Inter`). This change is monospace-only.
- Allowing per-element font tweaks via `.uatu.json` (font-size, line-height, weight). Out of scope.
- Bundling an additional non-monospace font. Hack Nerd Font Mono is the only bundled face for now.

## Decisions

### Decision 1: Variable name is `--mono-font-family`

Matches the existing `--terminal-font-family` pattern. The orphaned `--mono-font` reference at `src/styles.css:3134` gets rewritten to use the new name (we lose nothing — the orphaned name was never defined as a variable, so no user override depended on it).

**Alternative considered:** Keep `--mono-font` as the name, since it was already referenced. Rejected — `--terminal-font-family` is the established pattern, and parallelism makes the relationship between the two variables obvious to readers.

### Decision 2: Terminal variable references mono variable

The new `--terminal-font-family` definition collapses to:

```css
--terminal-font-family: var(--mono-font-family);
```

…with `--mono-font-family` carrying the actual stack (`"Hack Nerd Font Mono", ui-monospace, ...`). When `mono.fontFamily` is set in `.uatu.json`, the client writes it to `--mono-font-family`, and the terminal inherits it automatically. When `terminal.fontFamily` is also set, the client *additionally* writes it to `--terminal-font-family`, shadowing the inherit. That's the precedence: terminal > mono > bundled default.

**Alternative considered:** Keep `--terminal-font-family` as a fully independent stack. Rejected — that means `mono.fontFamily` would not flow into the terminal at all, and a user who sets only `mono.fontFamily` would see the bundled face in the terminal but their override everywhere else. Cluster of surprise.

### Decision 3: Add a small CSS block to win specificity vs `github-markdown-css`

`github-markdown-css` sets font-family on `.markdown-body pre code` (specificity 0,2,1). To override without `!important`, our rule needs to match that specificity. We add:

```css
.markdown-body pre,
.markdown-body code,
.markdown-body pre code,
.markdown-body samp,
.markdown-body tt,
.markdown-body kbd {
  font-family: var(--mono-font-family);
}
```

Specificity: 0,1,2 (matches `.markdown-body pre code`'s 0,1,2), so source order wins. Our stylesheet imports `github-markdown-css` *before* this rule, so we win.

**Alternative considered:** `!important`. Rejected — overrides made via `.uatu.json` would also need `!important`, and `!important` chains are a smell. The targeted selector list is short and explicit.

### Decision 4: `.uatu.json` schema mirrors `terminal` block

```json
{
  "mono": {
    "fontFamily": "Berkeley Mono, monospace"
  }
}
```

Validation: non-empty string after trim, otherwise warn and ignore (identical rules to `terminal.fontFamily`). The parser lives in `src/mono/config.ts` to mirror `terminal/config.ts`'s placement — feature-folder structure, colocated tests, the file scope is "everything about the mono-font capability". No font-size in this block (font-size for code blocks is a different conversation, out of scope).

**Alternative considered:** Reuse `terminal.fontFamily` as a global mono override and add a separate `terminal.exclusive` flag. Rejected — that overloads the meaning of `terminal.fontFamily` from "terminal only" to "either terminal only or global", and existing users with `terminal.fontFamily` set today would unexpectedly see their font everywhere on upgrade. The new namespace makes upgrade behavior boring.

### Decision 5: Apply via JS at boot, not just via SSR-injected `<style>`

`src/cli.ts` reads `.uatu.json mono.fontFamily` via the new loader, forwards via `/api/state.monoConfig`. `src/shell/boot.ts` (or whichever module owns initial DOM setup) reads `state.monoConfig.fontFamily` and writes it to `:root --mono-font-family` via `documentElement.style.setProperty`. Same mechanism as the existing terminal-config plumbing in `src/terminal/client.ts:191`.

**Alternative considered:** Serve a dynamic `:root` style block in the HTML response. Rejected — `/api/state` is already the canonical channel for runtime config; duplicating it as inline `<style>` would double the source of truth.

### Decision 6: Spec covers the *contract*, not the list of surfaces

The new `mono-font` spec asserts that "every monospace surface in the app SHALL resolve `font-family` to `var(--mono-font-family)`" rather than enumerating each CSS selector. Reason: the surface list will grow over time (new metadata cards, new sidebar panes), and pinning it in spec would force a spec change with every new mono-using element. The spec gets to stay stable; the implementation owns the selector inventory.

## Risks / Trade-offs

- **Risk:** A surface we missed continues to use a hardcoded stack and visually drifts from the rest. → Mitigation: implementation task explicitly enumerates and converts the seven known stacks; a grep-based check (`grep -n "font-family.*monospace" src/styles.css | grep -v "var(--mono-font-family)"`) becomes part of code-review hygiene. Optional follow-up: a unit test that scans `src/styles.css` and fails on hardcoded monospace stacks.
- **Risk:** A user has overridden their browser's monospace face globally and prefers that for code, not Hack. They lose that preference. → Mitigation: they set `mono.fontFamily` in `.uatu.json` to whatever they want (including a single generic `"monospace"` which falls through to their browser default). Documented in README.
- **Risk:** Some surfaces look worse in Hack Nerd Font Mono than in their OS monospace (Hack's character metrics differ from SF Mono / Consolas slightly). → Mitigation: this is a subjective trade-off; the override path is the answer for users who disagree. The terminal already proved the bundled face renders fine in browsers.
- **Risk:** The `@font-face` `font-display: block` policy means the first paint of code blocks blocks for up to 3s in Safari while the WOFF2 loads. → Mitigation: the WOFF2 is small (~1.2 MB), localhost-served, and after first load is cached `immutable`. If a real UX issue surfaces, a `font-display: optional` variant for non-terminal surfaces is a one-line follow-up — out of scope here.
- **Trade-off:** Code blocks and the terminal sharing a face means lines that look different in iTerm now look identical in uatu. Most users find this *more* coherent, not less; it's the same trade-off as VS Code's default `"editor.fontFamily" === "terminal.integrated.fontFamily"`.

## Migration Plan

No data migration. Users with existing `.uatu.json` files:

- If they have `terminal.fontFamily` set: zero change inside the terminal panel; other surfaces switch from OS monospace to Hack Nerd Font Mono unless they also add a `mono.fontFamily` entry.
- If they have no `terminal.fontFamily`: every monospace surface (including terminal) renders in Hack Nerd Font Mono. Same as what they already see in the terminal post-`bundle-nerd-font`, just consistent.
- If they want their previous OS-monospace look back: `{"mono": {"fontFamily": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"}}` reproduces it.

Rollback: revert the PR; the orphaned `--mono-font` reference at line 3134 (which was already orphaned before this change) goes back to falling through to its inline fallback.

## Open Questions

- Should we strip `--mono-font` entirely (the orphaned reference) and use `--mono-font-family` everywhere, or keep `--mono-font` as a back-compat alias that the orphan line keeps pointing at? Lean: strip — nothing in the codebase, in `.uatu.json` schemas, or in user docs ever defined `--mono-font`, so back-compat has no audience.
- Do we also want `font-size` and `line-height` knobs for code blocks? Out of scope for this change; can land as a follow-up if there's demand.
- Is there value in exposing the resolved mono family back to the user (e.g., a footer "fonts: Hack Nerd Font Mono" annotation)? Probably not; the user knows what they configured.
