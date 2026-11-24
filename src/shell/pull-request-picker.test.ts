import { describe, expect, test } from "bun:test";

import { pullRequestNumberFromQuery } from "./pull-request-picker";

describe("pullRequestNumberFromQuery", () => {
  test("reads a number, with or without #", () => {
    expect(pullRequestNumberFromQuery("642")).toBe(642);
    expect(pullRequestNumberFromQuery(" #642 ")).toBe(642);
  });

  test("reads a pull request URL, with or without a trailing tab", () => {
    expect(pullRequestNumberFromQuery("https://github.com/octo-org/uatu/pull/642")).toBe(642);
    expect(pullRequestNumberFromQuery("https://github.com/octo-org/uatu/pull/642/files?w=1")).toBe(642);
  });

  test("leaves words, zero and other URLs to the text search", () => {
    expect(pullRequestNumberFromQuery("fix 642")).toBeNull();
    expect(pullRequestNumberFromQuery("#0")).toBeNull();
    expect(pullRequestNumberFromQuery("https://github.com/octo-org/uatu/issues/642")).toBeNull();
    expect(pullRequestNumberFromQuery("")).toBeNull();
  });
});
