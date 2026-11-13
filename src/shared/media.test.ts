import { afterEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { mediaKind, mediaMimeType, mediaUrl } from "./media";
import { resetAppBasePathForTests } from "./app-url";
import { classifyFileName } from "../document/classify";
import { defaultDocumentId, isFollowableFile, isPreviewableFile, type RootGroup } from "./types";

afterEach(() => { delete (globalThis as { document?: unknown }).document; resetAppBasePathForTests(); });
const audio = ["mp3", "wav", "ogg", "oga", "flac", "aac", "m4a", "opus"];
const video = ["mp4", "m4v", "webm", "mov", "ogv", "avi", "mkv", "flv"];
test("recognized candidates use binary fast paths without promising codec support or Follow", () => {
  for (const [kind, extensions] of [["audio", audio], ["video", video]] as const) {
    for (const extension of extensions) {
      const name = `render.${extension.toUpperCase()}`;
      expect(mediaKind(name)).toBe(kind);
      expect(mediaMimeType(name)?.startsWith(`${kind}/`)).toBe(true);
      expect(classifyFileName(name)).toBe("binary");
      expect(isFollowableFile({ id: name, rootId: "r", relativePath: name, name, kind: "binary", mtimeMs: 0 })).toBe(false);
      expect(isPreviewableFile({ id: name, rootId: "r", relativePath: name, name, kind: "binary", mtimeMs: 0 })).toBe(true);
    }
  }
  expect(mediaMimeType("x.oga")).toBe("audio/ogg");
  expect(mediaMimeType("x.opus")).toBe("audio/ogg");
  expect(mediaMimeType("x.mov")).toBe("video/quicktime");
  for (const name of ["a", ".mp3", "image.png", "x.mp3.txt", "x.unknown", "x.ogx", "a.mp4/file", "x.mpeg"]) {
    expect(mediaKind(name)).toBeNull(); expect(mediaMimeType(name)).toBeNull();
  }
});

test("media URLs preserve root/path/epoch/revision identity and relocate through appUrl", () => {
  const { document } = parseHTML('<html><head><meta name="uatu-base-path" content="/s/work/" /></head></html>');
  (globalThis as { document?: unknown }).document = document; resetAppBasePathForTests();
  const doc = { rootId: "/root one", relativePath: "renders/a #&?.wav", revision: 42 };
  const first = new URL(mediaUrl(doc, "epoch-a"), "https://example.test");
  expect(first.pathname).toBe("/s/work/api/media");
  expect(Object.fromEntries(first.searchParams)).toEqual({ rootId: doc.rootId, path: doc.relativePath, epoch: "epoch-a", revision: "42" });
  expect(mediaUrl({ ...doc, rootId: "/root two" }, "epoch-a")).not.toBe(mediaUrl(doc, "epoch-a"));
  expect(mediaUrl({ ...doc, revision: 43 }, "epoch-a")).not.toBe(mediaUrl(doc, "epoch-a"));
  expect(mediaUrl(doc, "epoch-b")).not.toBe(mediaUrl(doc, "epoch-a"));
});

test("newer audio and video never become startup defaults or Follow-enable catch-up", () => {
  const root: RootGroup = { id: "r", path: "/r", label: "r", hiddenCount: 0, docs: [
    { id: "readme", rootId: "r", relativePath: "README.md", name: "README.md", kind: "markdown", mtimeMs: 1 },
    ...[...audio, ...video].map(extension => ({ id: `clip.${extension}`, rootId: "r", relativePath: `clip.${extension}`, name: `clip.${extension}`, kind: "binary" as const, mtimeMs: 1000 })),
  ] };
  expect(defaultDocumentId([root])).toBe("readme");
  expect(defaultDocumentId([{ ...root, docs: root.docs.slice(1) }])).toBeNull();
});
