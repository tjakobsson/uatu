import { writeClipboardText } from "../shared/clipboard";

export const CHAT_COPY_FEEDBACK_MS = 1_500;

type Timer = ReturnType<typeof setTimeout>;
type Schedule = (callback: () => void, delay: number) => Timer;
type Cancel = (timer: Timer) => void;
const feedbackTimers = new WeakMap<HTMLButtonElement, Timer>();
const originalLabels = new WeakMap<HTMLButtonElement, string>();

export async function copyChatText(
  button: HTMLButtonElement,
  text: string,
  announce: (message: string) => void,
  write: (value: string) => Promise<boolean> = writeClipboardText,
  schedule: Schedule = (callback, delay) => setTimeout(callback, delay),
  cancel: Cancel = timer => clearTimeout(timer),
): Promise<boolean> {
  let copied = false;
  try { copied = await write(text); } catch { copied = false; }

  const previous = feedbackTimers.get(button);
  if (previous !== undefined) cancel(previous);
  const originalLabel = originalLabels.get(button) ?? button.getAttribute("aria-label") ?? (button.textContent?.trim() || "Copy code block");
  originalLabels.set(button, originalLabel);
  button.dataset.state = copied ? "copied" : "failed";
  button.setAttribute("aria-label", copied ? "Copied" : "Copy failed");
  button.title = copied ? "Copied" : "Copy failed";
  announce(copied ? "Copied to clipboard" : "Could not copy to clipboard");

  const timer = schedule(() => {
    if (feedbackTimers.get(button) !== timer) return;
    feedbackTimers.delete(button);
    delete button.dataset.state;
    button.setAttribute("aria-label", originalLabel);
    button.title = originalLabel;
  }, CHAT_COPY_FEEDBACK_MS);
  feedbackTimers.set(button, timer);
  return copied;
}
