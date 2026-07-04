import { describe, expect, it } from "bun:test";

import { parsePsSnapshot, pickForegroundChild } from "./process-label";

// Column layout mirrors `ps -ax -o pid=,ppid=,stat=,comm=` on macOS/Linux.
const SNAPSHOT = `
  100     1  Ss   /bin/zsh
  200   100  S+   htop
  201   100  S    /usr/bin/tail
  300     1  Ss   /bin/zsh
  400   300  R+   /opt/homebrew/bin/btop
  401   300  S+   btop-helper
  500     1  Ss   /bin/zsh
`;

describe("parsePsSnapshot", () => {
  it("parses pid, ppid, foreground flag, and command", () => {
    const rows = parsePsSnapshot(SNAPSHOT);
    expect(rows).toHaveLength(7);
    expect(rows[1]).toEqual({ pid: 200, ppid: 100, foreground: true, command: "htop" });
    expect(rows[2]!.foreground).toBe(false);
  });

  it("skips malformed lines", () => {
    const rows = parsePsSnapshot("garbage line\n  abc def S+ comm\n");
    expect(rows).toHaveLength(0);
  });
});

describe("pickForegroundChild", () => {
  const rows = parsePsSnapshot(SNAPSHOT);

  it("picks the foreground child and basenames its command", () => {
    expect(pickForegroundChild(rows, 100)).toBe("htop");
  });

  it("prefers the newest foreground child and strips paths", () => {
    // pid 401 > 400, both foreground children of 300.
    expect(pickForegroundChild(rows, 300)).toBe("btop-helper");
  });

  it("returns null for a shell at its prompt (no foreground children)", () => {
    expect(pickForegroundChild(rows, 500)).toBeNull();
  });

  it("returns null for an unknown pid", () => {
    expect(pickForegroundChild(rows, 999)).toBeNull();
  });
});
