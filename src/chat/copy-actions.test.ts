import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { CHAT_COPY_FEEDBACK_MS, copyChatText } from "./copy-actions";

function button(): HTMLButtonElement {
  const { document } = parseHTML("<button></button>");
  const value = document.querySelector("button") as unknown as HTMLButtonElement;
  value.dataset.chatCopy = "code";
  return value;
}

describe("copyChatText", () => {
  test("contains success and failure and resets fixed feedback", async () => {
    for (const [result, state, message] of [[true, "copied", "Copied to clipboard"], [false, "failed", "Could not copy to clipboard"]] as const) {
      const control = button();
      const announcements: string[] = [];
      const writes: string[] = [];
      let reset: (() => void) | undefined;
      const copied = await copyChatText(control, "const x = 1;\n", value => announcements.push(value), async value => {
        writes.push(value);
        return result;
      }, (callback: () => void) => {
        reset = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      });
      expect(copied).toBe(result);
      expect(writes).toEqual(["const x = 1;\n"]);
      expect(control.dataset.state).toBe(state);
      expect(announcements).toEqual([message]);
      reset?.();
      expect(control.dataset.state).toBeUndefined();
      expect(control.getAttribute("aria-label")).toBe("Copy code block");
    }
  });

  test("bounds feedback and prevents an older reset clearing a newer result", async () => {
    const control = button();
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const cancelled: unknown[] = [];
    const schedule = ((callback: () => void, delay: number) => {
      scheduled.push({ callback, delay });
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    });
    await copyChatText(control, "first code", () => {}, async () => true, schedule, timer => { cancelled.push(timer); });
    await copyChatText(control, "second code", () => {}, async () => false, schedule, timer => { cancelled.push(timer); });
    expect(scheduled.map(entry => entry.delay)).toEqual([CHAT_COPY_FEEDBACK_MS, CHAT_COPY_FEEDBACK_MS]);
    expect(cancelled).toEqual([1]);
    scheduled[0]!.callback();
    expect(control.dataset.state).toBe("failed");
    scheduled[1]!.callback();
    expect(control.dataset.state).toBeUndefined();
  });

  test("contains an unexpected writer rejection", async () => {
    const control = button();
    expect(await copyChatText(control, "code", () => {}, async () => { throw new Error("denied"); }, () => 1 as unknown as ReturnType<typeof setTimeout>)).toBe(false);
    expect(control.dataset.state).toBe("failed");
  });
});
