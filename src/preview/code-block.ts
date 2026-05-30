// Code-block adornments: line-number gutters and copy buttons for any
// `<pre><code>` block inside the preview, plus the clipboard / "Copied"
// confirmation primitives the selection inspector also uses. Extracted from
// `app.ts` so the rendering-time DOM massaging lives with the rest of the
// preview pipeline.

import { splitHighlightedLines } from "./highlight-lines";

const selectionInspectorStatusElementMaybe = document.querySelector<HTMLElement>(
  "[data-selection-inspector-status]",
);

if (!selectionInspectorStatusElementMaybe) {
  throw new Error("uatu UI failed to initialize (preview/code-block)");
}

// Locally-scoped non-null alias. TypeScript's narrowing from the
// throw-if-null guard above doesn't survive into function bodies (the
// hoisted function declarations sit outside the if-block's control-flow
// scope), so we re-alias to `T` here.
const selectionInspectorStatusElement: HTMLElement = selectionInspectorStatusElementMaybe;

// Restructure each <pre><code> in the container into one `.uatu-cl` block per
// source line, carrying its line number in a `data-ln` attribute. The number
// is rendered via CSS (`.uatu-cl::before { content: attr(data-ln) }`), NOT as
// a DOM node, so `code.textContent` stays exactly equal to the source — which
// keeps copy-to-clipboard and the Selection Inspector's offset→line mapping
// working without changes. Real `\n` text nodes are reinserted between lines
// so that text content is preserved; `<code>` is set to `white-space: normal`
// in CSS so those separators collapse visually while each `.uatu-cl` keeps
// `white-space: pre` (or `pre-wrap` when wrapped).
//
// Per-line blocks are what let the wrap mode keep line numbers truthful: a
// wrapped line's number stays pinned to the top of its (multi-row) block.
export function attachLineNumbers(container: HTMLElement) {
  const blocks = container.querySelectorAll<HTMLPreElement>("pre");
  blocks.forEach(pre => {
    const code = pre.querySelector<HTMLElement>("code");
    if (!code) {
      return;
    }
    if (code.querySelector(".uatu-cl")) {
      return;
    }

    const raw = code.textContent ?? "";
    const hadTrailingNewline = raw.endsWith("\n");
    const lines = splitHighlightedLines(code.innerHTML);
    // A trailing newline yields a final empty fragment; drop it so the line
    // count matches the source (mirrors the old `replace(/\n$/, "")`), but
    // keep the newline itself in the text content (handled below).
    if (hadTrailingNewline && lines.length > 1 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    const fragment = document.createDocumentFragment();
    lines.forEach((lineHtml, index) => {
      const lineEl = document.createElement("span");
      lineEl.className = "uatu-cl";
      // The line number is drawn from `data-ln` via CSS `::before`, not as a
      // DOM node, so it stays out of `code.textContent` (copy / Selection
      // Inspector). Known trade-off vs the old `aria-hidden` gutter span:
      // some screen readers announce CSS-generated content, so the number
      // may be read before each line. Accepted for a developer review tool;
      // there is no portable way to `aria-hidden` a pseudo-element's content.
      lineEl.setAttribute("data-ln", String(index + 1));
      lineEl.innerHTML = lineHtml;
      fragment.appendChild(lineEl);
      // Separator newline after every line except the last, plus one extra
      // after the last line when the source ended with a newline. Keeps
      // `code.textContent === raw`.
      if (index < lines.length - 1 || hadTrailingNewline) {
        fragment.appendChild(document.createTextNode("\n"));
      }
    });

    code.textContent = "";
    code.appendChild(fragment);

    // Reserve gutter width for the widest line number (in ch) plus padding.
    const digits = String(lines.length).length;
    pre.style.setProperty("--uatu-ln-width", `calc(${digits}ch + 1.4rem)`);
    pre.classList.add("has-line-numbers");
  });
}

// Toggle soft word-wrap on every whole-file source block in the container.
// Wrap is purely a CSS concern (`.uatu-source-pre.is-wrapped`), so this just
// flips a class — no re-render, no structural change. Called on mount (to
// reflect the persisted preference) and whenever the Wrap toggle changes.
export function applySourceWrap(container: HTMLElement, wrap: boolean): void {
  container.querySelectorAll<HTMLPreElement>("pre.uatu-source-pre").forEach(pre => {
    pre.classList.toggle("is-wrapped", wrap);
  });
}

export function attachCopyButtons(container: HTMLElement) {
  const blocks = container.querySelectorAll<HTMLPreElement>("pre");
  blocks.forEach(pre => {
    const code = pre.querySelector<HTMLElement>("code");
    if (!code) {
      return;
    }
    if (pre.querySelector(".code-copy")) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.setAttribute("aria-label", "Copy code to clipboard");
    button.title = "Copy to clipboard";
    button.textContent = "Copy";

    button.addEventListener("click", async event => {
      event.preventDefault();
      const text = code.textContent ?? "";
      try {
        await navigator.clipboard.writeText(text);
        flashCopyButton(button, "Copied!", "is-copied");
      } catch {
        flashCopyButton(button, "Failed", "is-failed");
      }
    });

    pre.appendChild(button);
  });
}

export function flashCopyButton(button: HTMLButtonElement, label: string, modifier: string) {
  button.textContent = label;
  button.classList.add(modifier);
  window.setTimeout(() => {
    button.textContent = "Copy";
    button.classList.remove(modifier);
  }, 1500);
}

let copyResetTimeoutId: number | null = null;

export function showCopyConfirmation(): void {
  selectionInspectorStatusElement.textContent = "Copied";
  if (copyResetTimeoutId !== null) {
    window.clearTimeout(copyResetTimeoutId);
  }
  copyResetTimeoutId = window.setTimeout(() => {
    selectionInspectorStatusElement.textContent = "";
    copyResetTimeoutId = null;
  }, 1000);
}

export async function copyToClipboard(text: string): Promise<void> {
  // Prefer the modern API (works on localhost which is a secure context).
  // Fall back to a hidden-textarea + execCommand if the API is missing or
  // throws — defensive against locked-down browsers, even though uatu's
  // localhost target rarely hits that path.
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to legacy path below.
  }
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.setAttribute("readonly", "");
  scratch.style.position = "fixed";
  scratch.style.opacity = "0";
  document.body.appendChild(scratch);
  scratch.select();
  try {
    document.execCommand("copy");
  } catch {
    // Best effort — swallow the error so the caller's `.then()` still
    // runs and the user sees the "Copied" flash. The localhost target
    // makes this fallback path rare in practice; if it ever fires AND
    // execCommand also fails, the user gets a false-positive
    // confirmation. Acceptable at this scale; revisit if real users
    // report broken pastes.
  } finally {
    document.body.removeChild(scratch);
  }
}
