export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (typeof clipboard?.writeText === "function") {
      try {
        await clipboard.writeText(text);
        return true;
      } catch {
        // Try the legacy path when clipboard access is denied or fails.
      }
    }
  } catch {
    // Accessing navigator or clipboard can itself throw in locked-down contexts.
  }

  let scratch: HTMLTextAreaElement | null = null;
  try {
    if (
      typeof document === "undefined"
      || !document.body
      || typeof document.execCommand !== "function"
    ) {
      return false;
    }

    scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    scratch.style.position = "fixed";
    scratch.style.opacity = "0";
    document.body.appendChild(scratch);
    scratch.select();
    return document.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    if (scratch?.parentNode) {
      try {
        scratch.parentNode.removeChild(scratch);
      } catch {
        // Cleanup failure must not escape a clipboard attempt.
      }
    }
  }
}
