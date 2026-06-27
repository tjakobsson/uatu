import { describe, expect, it } from "bun:test";

import {
  SHELL_FALLBACK_NOTICE,
  SHELL_UNSET_STARTUP_WARNING,
  shellIsUnset,
} from "./shell-warning";

describe("shellIsUnset", () => {
  it("treats a non-empty SHELL as set", () => {
    expect(shellIsUnset({ SHELL: "/bin/zsh" })).toBe(false);
  });

  it("treats a missing SHELL as unset", () => {
    expect(shellIsUnset({})).toBe(true);
  });

  it("treats an empty or whitespace-only SHELL as unset", () => {
    expect(shellIsUnset({ SHELL: "" })).toBe(true);
    expect(shellIsUnset({ SHELL: "   " })).toBe(true);
  });
});

describe("fallback messages", () => {
  it("both name $SHELL and /bin/sh and lead with the consequence", () => {
    for (const message of [SHELL_UNSET_STARTUP_WARNING, SHELL_FALLBACK_NOTICE]) {
      expect(message).toContain("$SHELL is not set");
      expect(message).toContain("/bin/sh instead of your login shell");
    }
  });

  it("carries no `uatu:` prefix on the startup line (cli.ts adds it)", () => {
    expect(SHELL_UNSET_STARTUP_WARNING.startsWith("$SHELL")).toBe(true);
  });
});
