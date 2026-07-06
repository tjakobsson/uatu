import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import {
  acquireKeyboardLockOnce,
  createOsc52Handler,
  detectIsMac,
  handleClipboardKeyEvent,
  parseOsc52Payload,
  resetKeyboardLockForTests,
  type ClipboardTerminal,
  type Osc52Notice,
} from "./clipboard";

// --- helpers ----------------------------------------------------------------

type TermStub = ClipboardTerminal & {
  hasSelectionMock: ReturnType<typeof mock>;
  getSelectionMock: ReturnType<typeof mock>;
  clearSelectionMock: ReturnType<typeof mock>;
  pasteMock: ReturnType<typeof mock>;
};

function makeTerm(opts: { selection?: string } = {}): TermStub {
  const selection = opts.selection ?? "";
  const hasSelectionMock = mock(() => selection.length > 0);
  const getSelectionMock = mock(() => selection);
  const clearSelectionMock = mock(() => {});
  const pasteMock = mock((_: string) => {});
  return {
    hasSelection: hasSelectionMock as unknown as () => boolean,
    getSelection: getSelectionMock as unknown as () => string,
    clearSelection: clearSelectionMock as unknown as () => void,
    paste: pasteMock as unknown as (text: string) => void,
    hasSelectionMock,
    getSelectionMock,
    clearSelectionMock,
    pasteMock,
  };
}

type EventStub = {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  preventDefault: ReturnType<typeof mock>;
};

function makeEvent(
  key: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; type?: string } = {},
): EventStub {
  return {
    type: mods.type ?? "keydown",
    key,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: mods.meta ?? false,
    preventDefault: mock(() => {}),
  };
}

function call(
  event: EventStub,
  term: ClipboardTerminal,
  isMac = false,
): boolean {
  return handleClipboardKeyEvent(event as unknown as KeyboardEvent, term, isMac);
}

// Each test installs its own clipboard/navigator/window mocks via globalThis.
// We snapshot the originals once and restore them in afterEach so individual
// tests cannot leak global state.
const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
const originalWindow = (globalThis as { window?: unknown }).window;

function installClipboard(opts: {
  readText?: () => Promise<string>;
  writeText?: (text: string) => Promise<void>;
}): { readText: ReturnType<typeof mock>; writeText: ReturnType<typeof mock> } {
  const readText = mock(opts.readText ?? (async () => ""));
  const writeText = mock(opts.writeText ?? (async () => undefined));
  (globalThis as { navigator?: unknown }).navigator = {
    clipboard: { readText, writeText },
  };
  return { readText, writeText };
}

afterEach(() => {
  (globalThis as { navigator?: unknown }).navigator = originalNavigator;
  (globalThis as { window?: unknown }).window = originalWindow;
});

// --- handleClipboardKeyEvent ------------------------------------------------

describe("handleClipboardKeyEvent: bare Ctrl+C", () => {
  it("copies selection and clears it when text is selected", async () => {
    const { writeText } = installClipboard({});
    const term = makeTerm({ selection: "hello world" });
    const ev = makeEvent("c", { ctrl: true });

    const result = call(ev, term);

    expect(result).toBe(false);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toBe("hello world");
    expect(term.clearSelectionMock).toHaveBeenCalledTimes(1);
    expect(term.pasteMock).not.toHaveBeenCalled();
  });

  it("passes through (SIGINT) when there is no selection", () => {
    const { writeText } = installClipboard({});
    const term = makeTerm({ selection: "" });
    const ev = makeEvent("c", { ctrl: true });

    const result = call(ev, term);

    expect(result).toBe(true);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(term.clearSelectionMock).not.toHaveBeenCalled();
  });

  it("accepts uppercase `C` as the key value", async () => {
    const { writeText } = installClipboard({});
    const term = makeTerm({ selection: "x" });
    const ev = makeEvent("C", { ctrl: true });

    const result = call(ev, term);

    expect(result).toBe(false);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("is silent when writeText rejects (selection still cleared, event still swallowed)", async () => {
    installClipboard({ writeText: async () => { throw new Error("permission denied"); } });
    const term = makeTerm({ selection: "hello" });
    const ev = makeEvent("c", { ctrl: true });

    const result = call(ev, term);

    expect(result).toBe(false);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    // Selection clears synchronously; the rejection is fire-and-forget.
    expect(term.clearSelectionMock).toHaveBeenCalledTimes(1);
    // Let the rejection settle without bubbling to the test runner.
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe("handleClipboardKeyEvent: bare Ctrl+V", () => {
  it("reads clipboard and forwards to term.paste, swallowing the event", async () => {
    const { readText } = installClipboard({ readText: async () => "pasted-text" });
    const term = makeTerm();
    const ev = makeEvent("v", { ctrl: true });

    const result = call(ev, term);

    expect(result).toBe(false);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(readText).toHaveBeenCalledTimes(1);
    // readText is async — wait a tick before asserting term.paste was called.
    await Promise.resolve();
    await Promise.resolve();
    expect(term.pasteMock).toHaveBeenCalledTimes(1);
    expect(term.pasteMock.mock.calls[0]?.[0]).toBe("pasted-text");
  });

  it("is silent when readText rejects (no thrown error, no paste call)", async () => {
    installClipboard({ readText: async () => { throw new Error("permission denied"); } });
    const term = makeTerm();
    const ev = makeEvent("v", { ctrl: true });

    const result = call(ev, term);

    expect(result).toBe(false);
    // Allow the rejection to settle without bubbling.
    await Promise.resolve();
    await Promise.resolve();
    expect(term.pasteMock).not.toHaveBeenCalled();
  });

  it("does not call term.paste when clipboard text is empty", async () => {
    installClipboard({ readText: async () => "" });
    const term = makeTerm();
    const ev = makeEvent("v", { ctrl: true });

    const result = call(ev, term);

    expect(result).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(term.pasteMock).not.toHaveBeenCalled();
  });
});

describe("handleClipboardKeyEvent: Ctrl+Shift+C", () => {
  it("copies the selection, clears it, and swallows the event", async () => {
    const { writeText } = installClipboard({});
    const term = makeTerm({ selection: "selection" });
    const ev = makeEvent("c", { ctrl: true, shift: true });

    const result = call(ev, term);

    expect(result).toBe(false);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toBe("selection");
    // Matches Windows Terminal: selection clears as user-feedback that the
    // copy fired, identical to bare Ctrl+C.
    expect(term.clearSelectionMock).toHaveBeenCalledTimes(1);
  });

  it("swallows the event with no clipboard write when there's no selection", () => {
    const { writeText } = installClipboard({});
    const term = makeTerm({ selection: "" });
    const ev = makeEvent("c", { ctrl: true, shift: true });

    const result = call(ev, term);

    // Critical: returns false so DevTools shortcut doesn't open.
    expect(result).toBe(false);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("is silent when writeText rejects (event still swallowed, no throw)", async () => {
    installClipboard({ writeText: async () => { throw new Error("denied"); } });
    const term = makeTerm({ selection: "selection" });
    const ev = makeEvent("c", { ctrl: true, shift: true });

    const result = call(ev, term);

    expect(result).toBe(false);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    // Selection still clears synchronously — the writeText rejection is
    // fire-and-forget, so it doesn't gate the user-facing clear.
    expect(term.clearSelectionMock).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe("handleClipboardKeyEvent: Ctrl+Shift+V", () => {
  it("reads clipboard and pastes, swallowing the event", async () => {
    const { readText } = installClipboard({ readText: async () => "shifted-paste" });
    const term = makeTerm();
    const ev = makeEvent("v", { ctrl: true, shift: true });

    const result = call(ev, term);

    expect(result).toBe(false);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(readText).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(term.pasteMock).toHaveBeenCalledTimes(1);
    expect(term.pasteMock.mock.calls[0]?.[0]).toBe("shifted-paste");
  });
});

describe("handleClipboardKeyEvent: passthrough cases", () => {
  it("returns true for keys outside the handled set (letter 'a')", () => {
    installClipboard({});
    const term = makeTerm({ selection: "anything" });
    const ev = makeEvent("a", { ctrl: true });

    expect(call(ev, term)).toBe(true);
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it("returns true for keyup events even on handled chords", () => {
    const { writeText, readText } = installClipboard({});
    const term = makeTerm({ selection: "x" });
    const ev = makeEvent("c", { ctrl: true, type: "keyup" });

    expect(call(ev, term)).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
  });

  it("returns true when Alt modifier is held (Ctrl+Alt+C is not ours)", () => {
    const { writeText } = installClipboard({});
    const term = makeTerm({ selection: "x" });
    const ev = makeEvent("c", { ctrl: true, alt: true });

    expect(call(ev, term)).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("returns true when Meta modifier is held (Cmd-prefixed)", () => {
    const { writeText, readText } = installClipboard({});
    const term = makeTerm({ selection: "x" });
    const evC = makeEvent("c", { meta: true });
    const evV = makeEvent("v", { meta: true });

    expect(call(evC, term)).toBe(true);
    expect(call(evV, term)).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
  });
});

describe("handleClipboardKeyEvent: macOS short-circuit", () => {
  it("returns true for every chord when isMac is true", async () => {
    const { writeText, readText } = installClipboard({ readText: async () => "x" });
    const term = makeTerm({ selection: "x" });
    const chords: Array<{ key: string; ctrl: boolean; shift: boolean }> = [
      { key: "c", ctrl: true, shift: false },
      { key: "v", ctrl: true, shift: false },
      { key: "c", ctrl: true, shift: true },
      { key: "v", ctrl: true, shift: true },
    ];

    for (const c of chords) {
      const ev = makeEvent(c.key, { ctrl: c.ctrl, shift: c.shift });
      expect(call(ev, term, true)).toBe(true);
      expect(ev.preventDefault).not.toHaveBeenCalled();
    }
    expect(writeText).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    expect(term.pasteMock).not.toHaveBeenCalled();
    expect(term.clearSelectionMock).not.toHaveBeenCalled();
  });
});

// --- detectIsMac ------------------------------------------------------------

describe("detectIsMac", () => {
  function installNav(opts: { uad?: string; platform?: string } = {}): void {
    const nav: Record<string, unknown> = {};
    if (opts.uad !== undefined) nav.userAgentData = { platform: opts.uad };
    if (opts.platform !== undefined) nav.platform = opts.platform;
    (globalThis as { navigator?: unknown }).navigator = nav;
  }

  it("returns true when userAgentData.platform is 'macOS'", () => {
    installNav({ uad: "macOS" });
    expect(detectIsMac()).toBe(true);
  });

  it("returns true when userAgentData.platform is 'mac' (case-insensitive)", () => {
    installNav({ uad: "MAC" });
    expect(detectIsMac()).toBe(true);
  });

  it("returns true when only legacy navigator.platform is set to MacIntel", () => {
    installNav({ platform: "MacIntel" });
    expect(detectIsMac()).toBe(true);
  });

  it("returns false for Windows via userAgentData", () => {
    installNav({ uad: "Windows" });
    expect(detectIsMac()).toBe(false);
  });

  it("returns false for Linux via legacy platform", () => {
    installNav({ platform: "Linux x86_64" });
    expect(detectIsMac()).toBe(false);
  });

  it("prefers userAgentData over legacy platform when both are present", () => {
    // legacy says Mac, modern says Windows — should trust modern.
    installNav({ uad: "Windows", platform: "MacIntel" });
    expect(detectIsMac()).toBe(false);
  });

  it("returns false when neither source is populated", () => {
    installNav({});
    expect(detectIsMac()).toBe(false);
  });
});

// --- acquireKeyboardLockOnce ------------------------------------------------

describe("acquireKeyboardLockOnce", () => {
  beforeEach(() => {
    resetKeyboardLockForTests();
  });

  function installWindow(opts: { standalone: boolean }): void {
    (globalThis as { window?: unknown }).window = {
      matchMedia: (q: string) => ({
        matches: q === "(display-mode: standalone)" ? opts.standalone : false,
        media: q,
      }),
    };
  }

  function installNavigatorKeyboard(opts: {
    lock?: (keys: string[]) => Promise<void>;
  }): { lock?: ReturnType<typeof mock> } {
    if (opts.lock === undefined) {
      (globalThis as { navigator?: unknown }).navigator = {};
      return {};
    }
    const lock = mock(opts.lock);
    (globalThis as { navigator?: unknown }).navigator = { keyboard: { lock } };
    return { lock };
  }

  it("calls navigator.keyboard.lock once when standalone + API available", () => {
    installWindow({ standalone: true });
    const { lock } = installNavigatorKeyboard({ lock: async () => undefined });

    acquireKeyboardLockOnce();
    acquireKeyboardLockOnce();
    acquireKeyboardLockOnce();

    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock?.mock.calls[0]?.[0]).toEqual(["KeyC"]);
  });

  it("skips the call when display-mode is not standalone", () => {
    installWindow({ standalone: false });
    const { lock } = installNavigatorKeyboard({ lock: async () => undefined });

    acquireKeyboardLockOnce();

    expect(lock).not.toHaveBeenCalled();
  });

  it("skips the call when navigator.keyboard is missing", () => {
    installWindow({ standalone: true });
    installNavigatorKeyboard({}); // no `lock`
    // No assertion on the call; just confirm no throw.
    expect(() => acquireKeyboardLockOnce()).not.toThrow();
  });

  it("does NOT throw when lock rejects (silent diagnostic)", async () => {
    installWindow({ standalone: true });
    installNavigatorKeyboard({ lock: async () => { throw new Error("policy"); } });

    expect(() => acquireKeyboardLockOnce()).not.toThrow();
    // Let the rejection settle without bubbling to the test runner.
    await Promise.resolve();
    await Promise.resolve();
  });

  it("marks itself as attempted even when gates fail (does not retry)", () => {
    // First call: not standalone → skip but still mark attempted.
    installWindow({ standalone: false });
    const first = installNavigatorKeyboard({ lock: async () => undefined });
    acquireKeyboardLockOnce();
    expect(first.lock).not.toHaveBeenCalled();

    // Second call (after the gate would have flipped): still skipped because
    // the helper is single-shot per page.
    installWindow({ standalone: true });
    const second = installNavigatorKeyboard({ lock: async () => undefined });
    acquireKeyboardLockOnce();
    expect(second.lock).not.toHaveBeenCalled();
  });
});

// --- OSC 52 bridge -----------------------------------------------------------

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

describe("parseOsc52Payload", () => {
  it("parses a clipboard copy", () => {
    expect(parseOsc52Payload(`c;${b64("hello")}`)).toEqual({ kind: "copy", text: "hello" });
  });

  it("accepts primary and select selections (they map to the one clipboard)", () => {
    expect(parseOsc52Payload(`p;${b64("x")}`)).toEqual({ kind: "copy", text: "x" });
    expect(parseOsc52Payload(`s;${b64("x")}`)).toEqual({ kind: "copy", text: "x" });
    expect(parseOsc52Payload(`cps;${b64("x")}`)).toEqual({ kind: "copy", text: "x" });
  });

  it("accepts the empty-selection shorthand", () => {
    expect(parseOsc52Payload(`;${b64("x")}`)).toEqual({ kind: "copy", text: "x" });
  });

  it("decodes multi-byte UTF-8", () => {
    expect(parseOsc52Payload(`c;${b64("héllo ✓")}`)).toEqual({ kind: "copy", text: "héllo ✓" });
  });

  it("classifies the read query", () => {
    expect(parseOsc52Payload("c;?")).toEqual({ kind: "query" });
  });

  it("rejects unknown selection parameters", () => {
    expect(parseOsc52Payload(`q;${b64("x")}`)).toEqual({ kind: "invalid" });
    expect(parseOsc52Payload(`c7;${b64("x")}`)).toEqual({ kind: "invalid" });
  });

  it("rejects a payload without a separator", () => {
    expect(parseOsc52Payload(b64("x"))).toEqual({ kind: "invalid" });
  });

  it("rejects invalid base64", () => {
    expect(parseOsc52Payload("c;***not-base64***")).toEqual({ kind: "invalid" });
  });

  it("rejects an empty copy", () => {
    expect(parseOsc52Payload("c;")).toEqual({ kind: "invalid" });
  });

  it("accepts a payload exactly at the 100 KB cap", () => {
    const text = "a".repeat(100 * 1024);
    expect(parseOsc52Payload(`c;${b64(text)}`)).toEqual({ kind: "copy", text });
  });

  it("rejects a payload over the 100 KB cap as oversized", () => {
    const text = "a".repeat(100 * 1024 + 1);
    expect(parseOsc52Payload(`c;${b64(text)}`)).toEqual({ kind: "oversized" });
  });

  it("rejects a multi-megabyte payload without decoding (estimate path)", () => {
    // 8 MB of base64-looking data; must classify as oversized, not invalid.
    const junk = "A".repeat(8 * 1024 * 1024);
    expect(parseOsc52Payload(`c;${junk}`)).toEqual({ kind: "oversized" });
  });
});

describe("createOsc52Handler", () => {
  function collect() {
    const notices: Osc52Notice[] = [];
    return { notices, notify: (n: Osc52Notice) => notices.push(n) };
  }

  async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it("notify: writes and reports the copied length", async () => {
    const { notices, notify } = collect();
    const written: string[] = [];
    const handler = createOsc52Handler({
      policy: "notify",
      notify,
      writeText: async text => { written.push(text); },
    });

    expect(handler(`c;${b64("hello")}`)).toBe(true);
    await settle();
    expect(written).toEqual(["hello"]);
    expect(notices).toEqual([{ kind: "copied", chars: 5 }]);
  });

  it("silent: writes without a notice", async () => {
    const { notices, notify } = collect();
    const written: string[] = [];
    const handler = createOsc52Handler({
      policy: "silent",
      notify,
      writeText: async text => { written.push(text); },
    });

    handler(`c;${b64("quiet")}`);
    await settle();
    expect(written).toEqual(["quiet"]);
    expect(notices).toEqual([]);
  });

  it("confirm: never writes, emits pending with the text", async () => {
    const { notices, notify } = collect();
    const writeText = mock(async (_: string) => {});
    const handler = createOsc52Handler({ policy: "confirm", notify, writeText });

    handler(`c;${b64("check me")}`);
    await settle();
    expect(writeText).not.toHaveBeenCalled();
    expect(notices).toEqual([{ kind: "pending", text: "check me" }]);
  });

  it("promotes a rejected write to pending (notify and silent)", async () => {
    for (const policy of ["notify", "silent"] as const) {
      const { notices, notify } = collect();
      const handler = createOsc52Handler({
        policy,
        notify,
        writeText: async () => { throw new Error("needs user activation"); },
      });

      handler(`c;${b64("held")}`);
      await settle();
      expect(notices).toEqual([{ kind: "pending", text: "held" }]);
    }
  });

  it("never answers a query and never touches the clipboard for it", async () => {
    const { notices, notify } = collect();
    const writeText = mock(async (_: string) => {});
    const handler = createOsc52Handler({ policy: "notify", notify, writeText });

    expect(handler("c;?")).toBe(true);
    await settle();
    expect(writeText).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it("drops invalid payloads silently", async () => {
    const { notices, notify } = collect();
    const writeText = mock(async (_: string) => {});
    const handler = createOsc52Handler({ policy: "notify", notify, writeText });

    handler("c;***");
    await settle();
    expect(writeText).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it("reports oversized under notify and confirm, stays quiet under silent", async () => {
    const oversized = `c;${b64("a".repeat(100 * 1024 + 1))}`;
    for (const [policy, expected] of [
      ["notify", [{ kind: "oversized" }]],
      ["confirm", [{ kind: "oversized" }]],
      ["silent", []],
    ] as const) {
      const { notices, notify } = collect();
      const writeText = mock(async (_: string) => {});
      const handler = createOsc52Handler({ policy, notify, writeText });

      handler(oversized);
      await settle();
      expect(writeText).not.toHaveBeenCalled();
      expect(notices).toEqual(expected as never);
    }
  });
});
