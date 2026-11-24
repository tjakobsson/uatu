import { describe, expect, test } from "bun:test";

import { lookupText, nextListSelection, otherRepositoryName, pullRequestQueryTarget, shouldLookUp } from "./pull-request-picker";

const repository = { host: "github.com", owner: "octo-org", name: "uatu" };

describe("pullRequestQueryTarget", () => {
  test("reads a number, with or without #", () => {
    expect(pullRequestQueryTarget("642")).toEqual({ number: 642, repository: null });
    expect(pullRequestQueryTarget(" #642 ")).toEqual({ number: 642, repository: null });
  });

  test("reads a pull request URL and the repository it names, with or without a trailing tab", () => {
    expect(pullRequestQueryTarget("https://github.com/octo-org/uatu/pull/642")).toEqual({ number: 642, repository });
    expect(pullRequestQueryTarget("https://github.com/octo-org/uatu/pull/642/files?w=1")?.number).toBe(642);
  });

  test("leaves words, zero and other URLs to the text search", () => {
    expect(pullRequestQueryTarget("fix 642")).toBeNull();
    expect(pullRequestQueryTarget("#0")).toBeNull();
    expect(pullRequestQueryTarget("https://github.com/octo-org/uatu/issues/642")).toBeNull();
    expect(pullRequestQueryTarget("")).toBeNull();
  });
});

describe("otherRepositoryName", () => {
  test("this repository's URL (any case, www.) is not another's; a number names none", () => {
    expect(otherRepositoryName(pullRequestQueryTarget("https://github.com/octo-org/uatu/pull/1")!, repository)).toBeNull();
    expect(otherRepositoryName(pullRequestQueryTarget("https://www.GitHub.com/Octo-Org/UATU/pull/1")!, repository)).toBeNull();
    expect(otherRepositoryName(pullRequestQueryTarget("#1")!, repository)).toBeNull();
  });

  test("names another repository, with its host when that differs", () => {
    expect(otherRepositoryName(pullRequestQueryTarget("https://github.com/someone/else/pull/642")!, repository)).toBe("someone/else");
    expect(otherRepositoryName(pullRequestQueryTarget("https://ghe.example.com/octo-org/uatu/pull/642")!, repository)).toBe("ghe.example.com/octo-org/uatu");
  });
});

describe("lookupText", () => {
  test("one sentence per outcome, without repeating GitHub's own words", () => {
    expect(lookupText(600, { status: "loading" }, "octo-org/uatu")).toBe("#600 isn't in the open list. Looking it up on GitHub…");
    expect(lookupText(99999, { status: "error", message: "Pull request #99999 does not exist in octo-org/uatu.", missing: true }, "octo-org/uatu"))
      .toBe("There's no pull request #99999 in octo-org/uatu.");
    expect(lookupText(5, { status: "error", message: "GitHub is unreachable.", missing: false }, "octo-org/uatu")).toBe("Couldn't look up #5 on GitHub: GitHub is unreachable.");
  });

  test("a found pull request says why it isn't in the open list", () => {
    const pr = { state: "MERGED" } as Parameters<typeof lookupText>[1] extends infer L ? L extends { status: "found"; pr: infer P } ? P : never : never;
    expect(lookupText(600, { status: "found", pr }, "octo-org/uatu")).toBe("#600 is merged, so it isn't in the open list.");
  });
});

describe("nextListSelection", () => {
  const rows = [642, 639, 631];
  test("with nothing selected, Down starts at the first row and Up at the last", () => {
    expect(nextListSelection(rows, null, "ArrowDown")).toBe(642);
    expect(nextListSelection(rows, null, "ArrowUp")).toBe(631);
    expect(nextListSelection(rows, 7, "ArrowUp")).toBe(631);
  });
  test("moves one row and wraps at both ends", () => {
    expect(nextListSelection(rows, 642, "ArrowDown")).toBe(639);
    expect(nextListSelection(rows, 631, "ArrowDown")).toBe(642);
    expect(nextListSelection(rows, 642, "ArrowUp")).toBe(631);
    expect(nextListSelection([], null, "ArrowUp")).toBeNull();
  });
});

describe("shouldLookUp", () => {
  const base = { named: true, otherRepository: false, exactOpen: false, visibleMatches: 0, settled: true };
  test("looks a number up only once typing has paused and nothing open matches", () => {
    expect(shouldLookUp(base)).toBe(true);
    // Typing "6", "63" on the way to "636": not yet.
    expect(shouldLookUp({ ...base, settled: false })).toBe(false);
    // An open pull request matches what is typed: no lookup, no "not found".
    expect(shouldLookUp({ ...base, visibleMatches: 2 })).toBe(false);
    expect(shouldLookUp({ ...base, exactOpen: true })).toBe(false);
    expect(shouldLookUp({ ...base, otherRepository: true })).toBe(false);
    expect(shouldLookUp({ ...base, named: false })).toBe(false);
  });
});
