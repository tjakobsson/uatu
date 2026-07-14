import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { collectFileFacts, countLines } from "./file-facts";
import { safeGit } from "./git-base-ref";

const tempDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirectories.map(dir => rm(dir, { recursive: true, force: true })));
});

async function createDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-file-facts-"));
  tempDirectories.push(dir);
  return dir;
}

async function createRepo({ authorName = "Uatu Test" }: { authorName?: string } = {}): Promise<string> {
  const repo = await createDir();
  await safeGit(repo, ["init", "--initial-branch=main"]);
  await safeGit(repo, ["config", "user.email", "uatu@example.test"]);
  await safeGit(repo, ["config", "user.name", authorName]);
  return repo;
}

async function commitFile(repo: string, name: string, content: string, message = "initial"): Promise<void> {
  await writeFile(path.join(repo, name), content);
  await safeGit(repo, ["add", "--", name]);
  await safeGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", message]);
}

describe("countLines", () => {
  test("empty source is 0 lines", () => {
    expect(countLines("")).toBe(0);
  });

  test("counts newline-terminated lines", () => {
    expect(countLines("a\nb\nc\n")).toBe(3);
  });

  test("counts a final unterminated line", () => {
    expect(countLines("a\nb\nc")).toBe(3);
  });
});

describe("collectFileFacts", () => {
  test("clean committed file in a git root carries full git facts", async () => {
    const repo = await createRepo();
    const source = "# Doc\n\nbody\n";
    await commitFile(repo, "doc.md", source, "add doc");

    const facts = await collectFileFacts({
      absolutePath: path.join(repo, "doc.md"),
      rootPath: repo,
      source,
    });

    expect(facts).toBeDefined();
    expect(facts?.lines).toBe(3);
    expect(facts?.bytes).toBe(Buffer.byteLength(source));
    expect(Date.parse(facts?.mtime ?? "")).not.toBeNaN();
    expect(facts?.git).toBeDefined();
    expect(facts?.git?.author).toBe("Uatu Test");
    expect(facts?.git?.subject).toBe("add doc");
    expect(facts?.git?.shortSha).toMatch(/^[0-9a-f]{7,}$/);
    expect(Date.parse(facts?.git?.authoredAt ?? "")).not.toBeNaN();
    expect(facts?.git?.dirty).toBe(false);
  });

  test("uncommitted edits mark the file dirty while keeping last-commit facts", async () => {
    const repo = await createRepo();
    await commitFile(repo, "doc.md", "one\n");
    const edited = "one\ntwo\n";
    await writeFile(path.join(repo, "doc.md"), edited);

    const facts = await collectFileFacts({
      absolutePath: path.join(repo, "doc.md"),
      rootPath: repo,
      source: edited,
    });

    expect(facts?.git?.dirty).toBe(true);
    expect(facts?.git?.shortSha).toMatch(/^[0-9a-f]{7,}$/);
  });

  test("never-committed file in a git root has null commit facts and dirty=true", async () => {
    const repo = await createRepo();
    await commitFile(repo, "other.md", "x\n");
    await writeFile(path.join(repo, "fresh.md"), "new\n");

    const facts = await collectFileFacts({
      absolutePath: path.join(repo, "fresh.md"),
      rootPath: repo,
      source: "new\n",
    });

    expect(facts?.git).toEqual({
      author: null,
      authoredAt: null,
      shortSha: null,
      subject: null,
      dirty: true,
    });
  });

  test("unborn repository (git init, zero commits) still reports never-committed", async () => {
    // `git log` exits 128 on an unborn HEAD while `git status` works — this
    // must read as "in a repo, never committed", not as a non-git root.
    const repo = await createRepo();
    await writeFile(path.join(repo, "fresh.md"), "new\n");

    const facts = await collectFileFacts({
      absolutePath: path.join(repo, "fresh.md"),
      rootPath: repo,
      source: "new\n",
    });

    expect(facts?.git).toEqual({
      author: null,
      authoredAt: null,
      shortSha: null,
      subject: null,
      dirty: true,
    });
  });

  test("omitting the source skips the line count instead of reading the file", async () => {
    const repo = await createRepo();
    await commitFile(repo, "doc.md", "a\nb\n");

    const facts = await collectFileFacts({
      absolutePath: path.join(repo, "doc.md"),
      rootPath: repo,
    });

    expect(facts?.lines).toBeNull();
    expect(facts?.bytes).toBeGreaterThan(0);
    expect(facts?.git?.shortSha).toMatch(/^[0-9a-f]{7,}$/);
  });

  test("non-git root degrades to filesystem facts only", async () => {
    const dir = await createDir();
    await writeFile(path.join(dir, "notes.md"), "hello\n");

    const facts = await collectFileFacts({
      absolutePath: path.join(dir, "notes.md"),
      rootPath: dir,
      source: "hello\n",
    });

    expect(facts).toBeDefined();
    expect(facts?.lines).toBe(1);
    expect(facts?.git).toBeUndefined();
  });

  test("missing file yields no facts instead of throwing", async () => {
    const dir = await createDir();

    const facts = await collectFileFacts({
      absolutePath: path.join(dir, "gone.md"),
      rootPath: dir,
      source: "",
    });

    expect(facts).toBeUndefined();
  });

  test("author and subject are HTML-escaped before serialization", async () => {
    // git strips <> from author names itself, so exercise the characters it
    // preserves (& and quotes); the subject can carry full markup.
    const repo = await createRepo({ authorName: `Uatu "X" & Co` });
    await commitFile(repo, "doc.md", "x\n", "<script>alert(1)</script>");

    const facts = await collectFileFacts({
      absolutePath: path.join(repo, "doc.md"),
      rootPath: repo,
      source: "x\n",
    });

    expect(facts?.git?.author).toBe("Uatu &quot;X&quot; &amp; Co");
    expect(facts?.git?.subject).not.toContain("<script>");
    expect(facts?.git?.subject).toContain("&lt;script&gt;");
  });
});
