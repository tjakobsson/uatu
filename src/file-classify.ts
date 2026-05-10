import { promises as fs } from "node:fs";
import path from "node:path";

import { languageForName } from "./file-languages";
import type { DocumentKind } from "./shared";

const ADDITIONAL_TEXT_EXTENSIONS = new Set([
  ".txt",
  ".log",
  ".csv",
  ".tsv",
  ".env",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc",
  ".npmrc",
  ".nvmrc",
  ".lock",
  ".vue",
  ".svelte",
  ".astro",
]);

const TEXT_FILENAMES = new Set([
  "makefile",
  "dockerfile",
  "license",
  "license.txt",
  "readme",
  "changelog",
  "authors",
  "contributors",
  "copying",
  "notice",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".env",
  ".prettierrc",
  ".eslintrc",
  ".npmrc",
  ".nvmrc",
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tiff",
  ".tif",
  ".svg",
  ".avif",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".gz",
  ".tar",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".wasm",
  ".o",
  ".a",
  ".class",
  ".jar",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".mov",
  ".wav",
  ".ogg",
  ".flac",
  ".aac",
  ".webm",
  ".avi",
  ".mkv",
  ".flv",
  ".m4a",
  ".m4v",
  ".bin",
  ".dat",
  ".db",
  ".sqlite",
  ".sqlite3",
]);

const SNIFF_BYTES = 8192;
const NON_PRINTABLE_THRESHOLD = 0.3;

export function isMarkdownPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

// Note: GitHub also registers `.asc` for AsciiDoc, but `.asc` is overwhelmingly
// used for PGP ASCII-armored content (release signatures, public keys), and the
// AsciiDoc community itself recommends against `.asc` for AsciiDoc files. uatu
// deliberately excludes it.
export function isAsciidocPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".adoc") || lower.endsWith(".asciidoc");
}

function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  const dotIndex = lower.lastIndexOf(".");
  return dotIndex <= 0 ? "" : lower.slice(dotIndex);
}

function isKnownText(name: string): boolean {
  const lower = name.toLowerCase();
  if (TEXT_FILENAMES.has(lower)) {
    return true;
  }

  const ext = extensionOf(lower);
  if (!ext) {
    return false;
  }

  if (ADDITIONAL_TEXT_EXTENSIONS.has(ext)) {
    return true;
  }

  return languageForName(lower) !== undefined;
}

function isKnownBinary(name: string): boolean {
  const ext = extensionOf(name);
  return ext.length > 0 && BINARY_EXTENSIONS.has(ext);
}

export async function classifyFile(absolutePath: string, name?: string): Promise<DocumentKind> {
  const fileName = name ?? path.basename(absolutePath);

  if (isMarkdownPath(fileName)) {
    return "markdown";
  }

  if (isAsciidocPath(fileName)) {
    return "asciidoc";
  }

  if (isKnownText(fileName)) {
    return "text";
  }

  if (isKnownBinary(fileName)) {
    return "binary";
  }

  return await sniffBinary(absolutePath);
}

async function sniffBinary(absolutePath: string): Promise<DocumentKind> {
  let handle;
  try {
    handle = await fs.open(absolutePath, "r");
  } catch {
    return "binary";
  }

  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    if (bytesRead === 0) {
      return "text";
    }

    let nonPrintable = 0;
    for (let i = 0; i < bytesRead; i += 1) {
      const byte = buffer[i]!;
      if (byte === 0) {
        return "binary";
      }

      const isAllowedControl = byte === 0x09 || byte === 0x0a || byte === 0x0d;
      const isLowControl = byte < 0x20 && !isAllowedControl;
      const isDel = byte === 0x7f;
      if (isLowControl || isDel) {
        nonPrintable += 1;
      }
    }

    if (nonPrintable / bytesRead > NON_PRINTABLE_THRESHOLD) {
      return "binary";
    }

    return "text";
  } finally {
    await handle.close().catch(() => undefined);
  }
}
