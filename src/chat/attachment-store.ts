// Chat attachment store: image bytes uploaded from the composer, kept outside
// every watched root so the file watcher, the repository sweep, and the ignore
// engine never observe them. The layout is flat per workspace under an
// XDG-resolved state root (mirroring hub/state-dir.ts and debug/cache.ts):
//
//   <XDG_STATE_HOME|~/.local/state>/uatu/attachments/<workspace-key>/<uuid>.<ext>
//
// The filesystem is the index: an attachment id is a server-issued uuid, the
// stored basename is `<uuid>.<ext>`, and resolution accepts nothing but that
// shape — a client-supplied string is matched against the strict id pattern
// before any path is formed, never interpreted as a path itself. Display
// names are not persisted: the client keeps them for pending state and
// OpenCode echoes them back for replay, so the store only owns bytes and type.
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CHAT_ATTACHMENT_MAX_BYTES } from "./types";

export type StoredAttachment = {
  id: string;
  mimeType: string;
  sizeBytes: number;
  absolutePath: string;
};

export type AttachmentRefusal = "unsupported-type" | "too-large";

export class AttachmentStoreError extends Error {
  constructor(readonly reason: AttachmentRefusal, message: string) {
    super(message);
    this.name = "AttachmentStoreError";
  }
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// Type comes from the bytes, not from the client's claim: the four supported
// containers all carry unambiguous signatures.
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const head = String.fromCharCode(...bytes.subarray(0, 6));
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

export function resolveAttachmentStateRoot(env: Record<string, string | undefined> = process.env): string {
  const stateHome =
    env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim() !== ""
      ? env.XDG_STATE_HOME
      : path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "uatu", "attachments");
}

export type AttachmentStore = {
  save(bytes: Uint8Array): Promise<StoredAttachment>;
  resolve(id: string): Promise<StoredAttachment | null>;
  directory: string;
};

export type AttachmentStoreOptions = {
  workspacePath: string;
  // Overrides the XDG-resolved root; tests point this at a temp directory.
  root?: string;
  env?: Record<string, string | undefined>;
  maxBytes?: number;
};

export function createAttachmentStore(options: AttachmentStoreOptions): AttachmentStore {
  const root = options.root ?? resolveAttachmentStateRoot(options.env);
  const maxBytes = options.maxBytes ?? CHAT_ATTACHMENT_MAX_BYTES;
  // The key must not collide across workspaces and must not leak the path
  // into a directory name; a truncated digest gives both.
  const workspaceKey = createHash("sha256").update(path.resolve(options.workspacePath)).digest("hex").slice(0, 16);
  const directory = path.join(root, workspaceKey);
  let prepared: Promise<void> | undefined;

  const prepare = () => {
    prepared ??= fs.mkdir(directory, { recursive: true, mode: 0o700 }).then(() => undefined);
    return prepared;
  };

  return {
    directory,

    async save(bytes: Uint8Array): Promise<StoredAttachment> {
      const mimeType = sniffImageMime(bytes);
      if (mimeType === null) {
        throw new AttachmentStoreError("unsupported-type", "attachments must be PNG, JPEG, GIF, or WebP images");
      }
      if (bytes.byteLength > maxBytes) {
        throw new AttachmentStoreError("too-large", `attachments are limited to ${maxBytes} bytes`);
      }
      await prepare();
      const id = randomUUID();
      const absolutePath = path.join(directory, `${id}${EXTENSION_BY_MIME[mimeType]}`);
      await fs.writeFile(absolutePath, bytes, { mode: 0o600, flag: "wx" });
      return { id, mimeType, sizeBytes: bytes.byteLength, absolutePath };
    },

    async resolve(id: string): Promise<StoredAttachment | null> {
      if (!ID_PATTERN.test(id)) return null;
      for (const [extension, mimeType] of Object.entries(MIME_BY_EXTENSION)) {
        const absolutePath = path.join(directory, `${id}${extension}`);
        try {
          const stats = await fs.stat(absolutePath);
          if (!stats.isFile()) continue;
          return { id, mimeType, sizeBytes: stats.size, absolutePath };
        } catch {
          continue;
        }
      }
      return null;
    },
  };
}

// Finds an issued id inside free text — OpenCode's durable store rewrites a
// file part's url to a data: URL, but the synthetic caption it adds beside it
// ("Called the Read tool with {\"filePath\": ...}") carries the stored path,
// whose basename is the issued uuid. Anchored to `<uuid>.<known-extension>`
// so arbitrary caption prose cannot fabricate a reference.
const ID_IN_TEXT_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:png|jpg|gif|webp)\b/;

export function attachmentIdFromText(value: string): string | null {
  const match = ID_IN_TEXT_PATTERN.exec(value);
  return match ? match[1]! : null;
}

// Parses an issued id back out of an echoed `file:` URI (design D5): accepts
// exactly `<uuid>.<known-extension>` basenames and nothing else.
export function attachmentIdFromFileUri(uri: string): string | null {
  if (!uri.startsWith("file:")) return null;
  let pathname: string;
  try {
    pathname = new URL(uri).pathname;
  } catch {
    return null;
  }
  const basename = pathname.split("/").pop() ?? "";
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = basename.slice(0, dot);
  const extension = basename.slice(dot);
  if (!ID_PATTERN.test(id) || MIME_BY_EXTENSION[extension] === undefined) return null;
  return id;
}
