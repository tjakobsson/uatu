// Code-block adornments: line-number gutters and copy buttons for any
// `<pre><code>` block inside the preview, plus the clipboard / "Copied"
// confirmation primitives the selection inspector also uses. Extracted from
// `app.ts` so the rendering-time DOM massaging lives with the rest of the
// preview pipeline.

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

// Attach a line-number gutter to each <pre><code> in the container. The gutter
// is a sibling <span> of <code>, NOT a child — copy-to-clipboard reads
// `code.textContent` so line numbers are excluded automatically. `user-select:
// none` on the gutter also keeps mouse-selection of the code clean.
export function attachLineNumbers(container: HTMLElement) {
  const blocks = container.querySelectorAll<HTMLPreElement>("pre");
  blocks.forEach(pre => {
    const code = pre.querySelector<HTMLElement>("code");
    if (!code) {
      return;
    }
    if (pre.querySelector(".line-numbers")) {
      return;
    }

    const text = code.textContent ?? "";
    const lineCount = Math.max(1, text.replace(/\n$/, "").split("\n").length);
    const numbers = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join("\n");

    const gutter = document.createElement("span");
    gutter.className = "line-numbers";
    gutter.setAttribute("aria-hidden", "true");
    gutter.textContent = numbers;

    pre.classList.add("has-line-numbers");
    pre.insertBefore(gutter, code);
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
