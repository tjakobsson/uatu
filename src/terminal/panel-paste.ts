import type { TerminalPanelHandle } from "./client";

type PasteHandle = Pick<TerminalPanelHandle, "focus" | "isAttached" | "paste">;

export function pasteToActiveTerminal(
  getActiveHandle: () => PasteHandle | null,
  text: string,
): boolean {
  const handle = getActiveHandle();
  if (!handle?.isAttached()) return false;
  handle.paste(text);
  handle.focus();
  return true;
}
