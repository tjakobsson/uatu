// The file view's Git reader (add-github-pr-review D17, task 9.4) over a real
// temporary repository: exact bytes (binary included), no filters, the
// tree listing, and Git LFS pointers.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createPullRequestRemote, type PullRequestRemote } from "../../tests/fixtures/pull-request-remote";
import { commitPresent, listTree, parseBatchObject, parseLfsPointer, readBlob } from "./git-objects";

const LFS_POINTER = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n";
const BINARY = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x0a, 0x0d, 0x00, 0x01]);

let remote: PullRequestRemote;
let head = "";

beforeAll(async () => {
  remote = await createPullRequestRemote();
  // A text filter and CRLF conversion that a working-tree read would apply;
  // the object reader must not.
  await remote.git(remote.contributor, "config", "core.autocrlf", "true");
  head = await remote.commit({
    ".gitattributes": "*.md text eol=crlf\n",
    "docs/crlf.md": "line one\r\nline two\r\n",
    "images/logo.png": BINARY,
    "assets/big.bin": LFS_POINTER,
    "path with spaces/ünïcode.md": "# Hi\n",
  }, "files");
}, 30_000);
afterAll(() => remote?.cleanup());

describe("git objects", () => {
  test("commitPresent tells a local commit from one that isn't", async () => {
    expect(await commitPresent(remote.contributor, head)).toBe(true);
    expect(await commitPresent(remote.contributor, "0".repeat(40))).toBe(false);
    expect(await commitPresent(remote.contributor, "not-an-oid")).toBe(false);
  });

  test("readBlob answers the exact stored bytes, binary included", async () => {
    const png = await readBlob(remote.contributor, head, "images/logo.png", { maxBytes: 1024 });
    expect(png.kind).toBe("blob");
    if (png.kind === "blob") expect([...png.bytes]).toEqual([...BINARY]);
    const crlf = await readBlob(remote.contributor, head, "docs/crlf.md", { maxBytes: 1024 });
    // Stored normalized (LF); no smudge or eol conversion on the way out.
    expect(crlf.kind === "blob" && crlf.bytes.toString("utf8")).toBe("line one\nline two\n");
    const unicode = await readBlob(remote.contributor, head, "path with spaces/ünïcode.md", { maxBytes: 1024 });
    expect(unicode.kind === "blob" && unicode.bytes.toString("utf8")).toBe("# Hi\n");
  });

  test("readBlob refuses a missing path, a directory and a newline, and leaves a large blob unread", async () => {
    expect(await readBlob(remote.contributor, head, "nope.md", { maxBytes: 1024 })).toEqual({ kind: "missing" });
    expect(await readBlob(remote.contributor, head, "docs", { maxBytes: 1024 })).toEqual({ kind: "missing" });
    expect(await readBlob(remote.contributor, head, "docs/a\nb.md", { maxBytes: 1024 })).toEqual({ kind: "missing" });
    expect(await readBlob(remote.contributor, head, "images/logo.png", { maxBytes: 4 })).toMatchObject({ kind: "too-large", size: BINARY.length });
  });

  test("listTree lists every file with sizes, and stops at its limit", async () => {
    const tree = await listTree(remote.contributor, head, { limit: 100 });
    expect(tree?.truncated).toBe(false);
    expect(tree?.entries.map(entry => entry.path).sort()).toEqual([
      ".gitattributes", "README.md", "assets/big.bin", "docs/crlf.md", "docs/guide.md", "images/logo.png", "path with spaces/ünïcode.md",
    ]);
    expect(tree?.entries.find(entry => entry.path === "images/logo.png")?.size).toBe(BINARY.length);
    const short = await listTree(remote.contributor, head, { limit: 3 });
    expect(short).toMatchObject({ truncated: true });
    expect(short?.entries).toHaveLength(3);
    expect(await listTree(remote.contributor, "0".repeat(40), { limit: 3 })).toBeNull();
  });

  test("an LFS pointer is recognized and stays its pointer text", async () => {
    const read = await readBlob(remote.contributor, head, "assets/big.bin", { maxBytes: 1024 });
    expect(read.kind === "blob" && read.bytes.toString("utf8")).toBe(LFS_POINTER);
    expect(read.kind === "blob" && parseLfsPointer(read.bytes)).toEqual({ oid: "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393", size: 12345 });
    expect(parseLfsPointer(new TextEncoder().encode("version https://git-lfs.github.com/spec/v1\nsize 1\n"))).toBeNull();
    expect(parseLfsPointer(new TextEncoder().encode("# just markdown\n"))).toBeNull();
  });

  test("parseBatchObject reads one --batch answer, and refuses a mismatched or short one", () => {
    const oid = "a".repeat(40);
    expect(parseBatchObject(Buffer.from(`${oid} blob 3\nabc\n`), oid)?.toString()).toBe("abc");
    expect(parseBatchObject(Buffer.from(`${oid} blob 3\nab`), oid)).toBeNull();
    expect(parseBatchObject(Buffer.from(`${"b".repeat(40)} blob 3\nabc\n`), oid)).toBeNull();
  });
});
