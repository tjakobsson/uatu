import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  attachmentIdFromFileUri,
  AttachmentStoreError,
  createAttachmentStore,
  resolveAttachmentStateRoot,
  sniffImageMime,
} from "./attachment-store";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const GIF = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x0c, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 "),
]);

async function temporaryRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "uatu-attachments-"));
}

describe("sniffImageMime", () => {
  test("recognizes the four supported containers by signature", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(GIF)).toBe("image/gif");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
  });

  test("rejects non-image bytes regardless of any claimed type", () => {
    expect(sniffImageMime(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageMime(Buffer.from("%PDF-1.4"))).toBeNull();
    expect(sniffImageMime(Buffer.from("plain text"))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });
});

describe("createAttachmentStore", () => {
  test("saves and resolves a supported image round-trip", async () => {
    const store = createAttachmentStore({ workspacePath: "/tmp/ws", root: await temporaryRoot() });
    const saved = await store.save(PNG);
    expect(saved.mimeType).toBe("image/png");
    expect(saved.sizeBytes).toBe(PNG.byteLength);
    expect(saved.absolutePath.endsWith(`${saved.id}.png`)).toBe(true);

    const resolved = await store.resolve(saved.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.absolutePath).toBe(saved.absolutePath);
    expect(resolved!.mimeType).toBe("image/png");
    expect(await fs.readFile(resolved!.absolutePath)).toEqual(PNG);
  });

  test("stored extension follows the sniffed type, not any client claim", async () => {
    const store = createAttachmentStore({ workspacePath: "/tmp/ws", root: await temporaryRoot() });
    const saved = await store.save(GIF);
    expect(saved.absolutePath.endsWith(".gif")).toBe(true);
  });

  test("refuses unsupported bytes as unsupported-type", async () => {
    const store = createAttachmentStore({ workspacePath: "/tmp/ws", root: await temporaryRoot() });
    const refusal = await store.save(Buffer.from("%PDF-1.4 not an image")).catch((error) => error);
    expect(refusal).toBeInstanceOf(AttachmentStoreError);
    expect((refusal as AttachmentStoreError).reason).toBe("unsupported-type");
  });

  test("refuses bytes over the cap as too-large", async () => {
    const store = createAttachmentStore({ workspacePath: "/tmp/ws", root: await temporaryRoot(), maxBytes: PNG.byteLength });
    const oversized = Buffer.concat([PNG, Buffer.from([0x00])]);
    const refusal = await store.save(oversized).catch((error) => error);
    expect(refusal).toBeInstanceOf(AttachmentStoreError);
    expect((refusal as AttachmentStoreError).reason).toBe("too-large");
    const names = await fs.readdir((await import("node:path")).dirname((await store.save(PNG)).absolutePath));
    expect(names.every((name) => name.endsWith(".png"))).toBe(true);
  });

  test("hostile identifiers resolve to null without filesystem interpretation", async () => {
    const root = await temporaryRoot();
    const store = createAttachmentStore({ workspacePath: "/tmp/ws", root });
    await store.save(PNG);
    expect(await store.resolve("../../etc/passwd")).toBeNull();
    expect(await store.resolve("..%2f..%2fetc%2fpasswd")).toBeNull();
    expect(await store.resolve("11111111-2222-4333-8444-55555555555.png")).toBeNull();
    expect(await store.resolve("not-issued")).toBeNull();
    expect(await store.resolve("")).toBeNull();
    // A well-formed id that was never issued is a miss, not an error.
    expect(await store.resolve("11111111-2222-4333-8444-555555555555")).toBeNull();
  });

  test("workspaces get distinct directories under the same root", async () => {
    const root = await temporaryRoot();
    const one = createAttachmentStore({ workspacePath: "/tmp/ws-one", root });
    const two = createAttachmentStore({ workspacePath: "/tmp/ws-two", root });
    const saved = await one.save(PNG);
    expect(one.directory).not.toBe(two.directory);
    expect(await two.resolve(saved.id)).toBeNull();
  });

  test("the state root resolves via XDG_STATE_HOME and stays outside any workspace", () => {
    const resolved = resolveAttachmentStateRoot({ XDG_STATE_HOME: "/tmp/xdg-state" });
    expect(resolved).toBe(path.join("/tmp/xdg-state", "uatu", "attachments"));
    const fallback = resolveAttachmentStateRoot({});
    expect(fallback).toBe(path.join(os.homedir(), ".local", "state", "uatu", "attachments"));
  });
});

describe("attachmentIdFromFileUri", () => {
  test("recovers the issued id from an echoed file uri", () => {
    expect(attachmentIdFromFileUri("file:///var/state/uatu/attachments/ab/11111111-2222-4333-8444-555555555555.png"))
      .toBe("11111111-2222-4333-8444-555555555555");
    expect(attachmentIdFromFileUri("file:///store/11111111-2222-4333-8444-555555555555.webp"))
      .toBe("11111111-2222-4333-8444-555555555555");
  });

  test("rejects everything that is not an issued-id basename", () => {
    expect(attachmentIdFromFileUri("data:image/png;base64,AAAA")).toBeNull();
    expect(attachmentIdFromFileUri("https://example.test/11111111-2222-4333-8444-555555555555.png")).toBeNull();
    expect(attachmentIdFromFileUri("file:///store/readme.png")).toBeNull();
    expect(attachmentIdFromFileUri("file:///store/11111111-2222-4333-8444-555555555555.svg")).toBeNull();
    expect(attachmentIdFromFileUri("file:///store/11111111-2222-4333-8444-555555555555")).toBeNull();
    expect(attachmentIdFromFileUri("not a uri")).toBeNull();
  });
});
