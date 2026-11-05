import { expect, test } from "bun:test";
import { compareTreePaths, matchesMediaType } from "./media-browsing-model";
import type { DocumentMeta } from "../shared/types";

const doc = (name: string): DocumentMeta => ({ id: name, rootId: "root", relativePath: name, name, kind: "binary", mtimeMs: 1 });

test("runtime type membership recognizes candidates without claiming codec support", () => {
  expect(matchesMediaType(doc("bass.WAV"), "audio")).toBe(true);
  expect(matchesMediaType(doc("bass.opus"), "audio")).toBe(true);
  expect(matchesMediaType(doc("render.mov"), "video")).toBe(true);
  expect(matchesMediaType(doc("render.mkv"), "video")).toBe(true);
  expect(matchesMediaType(doc("bass.wav"), "video")).toBe(false);
  expect(matchesMediaType(doc("render.webm"), "audio")).toBe(false);
  expect(matchesMediaType(doc("archive.zip"), "audio")).toBe(false);
  expect(matchesMediaType(doc("source.md"), "all")).toBe(true);
});

test("captured tree order includes closed folders, directory-first hierarchy, natural names, and case ties", () => {
  const paths = ["z.wav", "B.wav", "b.wav", "a10.wav", "a02.wav", "a2.wav", "z/render.wav", "A/render10.wav", "A/render2.wav"];
  expect([...paths].sort(compareTreePaths)).toEqual(["A/render2.wav", "A/render10.wav", "z/render.wav", "a02.wav", "a2.wav", "a10.wav", "B.wav", "b.wav", "z.wav"]);
  expect(paths[0]).toBe("z.wav");
});
