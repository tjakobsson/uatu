import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { classifyFile, isMarkdownPath } from "./file-classify";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })),
  );
});

async function makeTempFile(name: string, contents: Buffer | string): Promise<string> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-classify-"));
  tempDirectories.push(tempDirectory);
  const filePath = path.join(tempDirectory, name);
  await writeFile(filePath, contents);
  return filePath;
}

describe("isMarkdownPath", () => {
  test("matches .md and .markdown extensions case-insensitively", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("guide.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("script.py")).toBe(false);
    expect(isMarkdownPath("logo.png")).toBe(false);
  });
});

describe("classifyFile", () => {
  test("classifies known-markdown extensions as markdown", async () => {
    const filePath = await makeTempFile("README.md", "# Hello\n");
    expect(await classifyFile(filePath)).toBe("markdown");
  });

  test("classifies known-text extensions as text", async () => {
    const filePath = await makeTempFile("config.yaml", "key: value\n");
    expect(await classifyFile(filePath)).toBe("text");
  });

  test("classifies known-binary extensions as binary without reading", async () => {
    // Contents are irrelevant — extension wins.
    const filePath = await makeTempFile("logo.png", "definitely not png");
    expect(await classifyFile(filePath)).toBe("binary");
  });

  test("classifies extensionless ASCII Makefile as text via filename match", async () => {
    const filePath = await makeTempFile("Makefile", "all:\n\techo hi\n");
    expect(await classifyFile(filePath)).toBe("text");
  });

  test("sniffs unknown extension with NUL byte as binary", async () => {
    const blob = Buffer.from([0x68, 0x65, 0x00, 0x6c, 0x6c, 0x6f]);
    const filePath = await makeTempFile("payload.unknown", blob);
    expect(await classifyFile(filePath)).toBe("binary");
  });

  test("sniffs unknown extension with high non-printable ratio as binary", async () => {
    const bytes = Buffer.alloc(64);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = i % 0x1f === 0 ? 0x41 : 0x01;
    }
    const filePath = await makeTempFile("blob.weirdtype", bytes);
    expect(await classifyFile(filePath)).toBe("binary");
  });

  test("sniffs unknown extension with plain UTF-8 text as text", async () => {
    const filePath = await makeTempFile(
      "notes.weirdtype",
      "Hello, world!\nMulti-byte: café\n",
    );
    expect(await classifyFile(filePath)).toBe("text");
  });

  test("treats empty files as text", async () => {
    const filePath = await makeTempFile("empty.weirdtype", "");
    expect(await classifyFile(filePath)).toBe("text");
  });
});
