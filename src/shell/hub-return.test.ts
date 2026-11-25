import { describe, expect, test } from "bun:test";

import { hubLocationDetail, hubLocationLabel, hubReturnLocation } from "./hub-return";

const base = "/s/uatu/";
const url = (path: string) => new URL(`http://hub.test${path}`);
const titles = (number: number) => (number === 1 ? "Refresh the guide" : null);

describe("what the Back control names", () => {
  test("a pull request by number and title, or number alone before its title is known", () => {
    expect(hubLocationDetail(url("/s/uatu/?pr=1&tab=files&thread=t1"), base, titles)).toBe("#1 Refresh the guide");
    expect(hubLocationDetail(url("/s/uatu/?pr=7&path=docs/a.md"), base, titles)).toBe("#7");
  });

  test("a document by its path, a commit by its short sha, the workspace root by nothing", () => {
    expect(hubLocationDetail(url("/s/uatu/docs/hub%20guide.md#setup"), base, titles)).toBe("docs/hub guide.md");
    expect(hubLocationDetail(url("/s/uatu/?repository=r&commit=0123456789abcdef"), base, titles)).toBe("commit 0123456");
    expect(hubLocationDetail(url("/s/uatu/"), base, titles)).toBeNull();
    expect(hubLocationDetail(url("/s/uatu/?pr=0"), base, titles)).toBeNull();
  });

  test("the label is the workspace name, then what is open", () => {
    expect(hubLocationLabel("uatu", "docs/hub.md")).toBe("uatu · docs/hub.md");
    expect(hubLocationLabel("uatu", null)).toBe("uatu");
  });

  test("the record keeps the exact in-app location: path, query and fragment", () => {
    expect(hubReturnLocation("uatu-pr-sandbox", "uatu-pr-sandbox", url("/s/uatu-pr-sandbox/?pr=1&tab=files&file=a.md"), "/s/uatu-pr-sandbox/", titles)).toEqual({
      workspace: "uatu-pr-sandbox",
      name: "uatu-pr-sandbox",
      label: "uatu-pr-sandbox · #1 Refresh the guide",
      href: "/s/uatu-pr-sandbox/?pr=1&tab=files&file=a.md",
    });
  });
});
