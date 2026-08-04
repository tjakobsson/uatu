import { describe, expect, test } from "bun:test";

import { formatSessionUrl, printIndexingStatus, printStartupBanner, STARTUP_BANNER } from "./output";

describe("printStartupBanner", () => {
  test("prints the ASCII banner with a leading newline when stdout is a TTY", () => {
    const chunks: string[] = [];
    printStartupBanner({ isTTY: true, write: chunk => chunks.push(chunk) });
    const output = chunks.join("");
    expect(output.startsWith("\n")).toBe(true);
    expect(output).toContain(STARTUP_BANNER);
    expect(output).toContain("I observe. I follow. I render.");
  });

  test("writes nothing when stdout is not a TTY", () => {
    const chunks: string[] = [];
    printStartupBanner({ isTTY: false, write: chunk => chunks.push(chunk) });
    expect(chunks).toHaveLength(0);
  });

  test("prints and clears indexing status when stdout is a TTY", () => {
    const chunks: string[] = [];
    const clear = printIndexingStatus([{ kind: "dir", absolutePath: "/repo" }], {
      isTTY: true,
      write: chunk => chunks.push(chunk),
    });

    expect(chunks.join("")).toContain("Indexing /repo...");
    clear();
    expect(chunks.join("")).toContain("\r");
  });

  test("writes no indexing status when stdout is not a TTY", () => {
    const chunks: string[] = [];
    const clear = printIndexingStatus([{ kind: "dir", absolutePath: "/repo" }], {
      isTTY: false,
      write: chunk => chunks.push(chunk),
    });

    clear();
    expect(chunks).toHaveLength(0);
  });
});

describe("formatSessionUrl", () => {
  test("default base path with a token matches the historical shape", () => {
    expect(formatSessionUrl(4711, "/", "abc")).toBe("http://127.0.0.1:4711/?t=abc");
  });

  test("default base path without a token is the slashless origin", () => {
    expect(formatSessionUrl(4711, "/")).toBe("http://127.0.0.1:4711");
  });

  test("a base path is carried in both token and tokenless forms", () => {
    expect(formatSessionUrl(4711, "/s/uatu/", "abc")).toBe("http://127.0.0.1:4711/s/uatu/?t=abc");
    expect(formatSessionUrl(4711, "/s/uatu/")).toBe("http://127.0.0.1:4711/s/uatu/");
  });

  test("token values are URL-encoded", () => {
    expect(formatSessionUrl(4711, "/", "a+b/c")).toBe("http://127.0.0.1:4711/?t=a%2Bb%2Fc");
  });
});
