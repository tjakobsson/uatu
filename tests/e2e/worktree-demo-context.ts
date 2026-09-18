// In-memory services for the actual workspace frontend. No watchers, filesystem
// attachment store, terminal backend, credentials, providers or subprocesses.
import type { StoredAttachment } from "../../src/chat/attachment-store";
import { DEMO_BUILD } from "./worktree-demo-build";
import type { StatePayload } from "../../src/shared/types";
import type { PersonalWorkspaceState } from "../../src/shell/personal-state";
import { escapeHtml } from "../../src/shared/html";
import { DemoChatService } from "./worktree-demo-chat";

export class DemoWorkspaceContext {
  readonly files = new Map<string, string>();
  readonly attachments = new Map<string, { record: StoredAttachment; bytes: Uint8Array }>();
  readonly terminals = new Map<string, { id: string; createdAt: number; attached: boolean; output: string }>();
  readonly chat: DemoChatService;
  personal: PersonalWorkspaceState = { version: 1, follow: false };
  readonly createdAt: number;
  constructor(readonly id: string, readonly name: string, readonly generation: number, readonly path = `/demo/workspaces/${id}`) {
    this.createdAt = Date.now();
    this.files.set("README.md", `# ${name} workspace\n\nIndependent checkout: ${id}. Simulated files, terminal and conversations belong only to this workspace.`);
    this.files.set("NOTES.md", `# ${name} notes\n\nSelected document for ${id}. No source conversation has been migrated here.`);
    const attachmentStore = {
      directory: `memory:${id}`,
      save: async (bytes: Uint8Array) => {
        const signature = new TextDecoder().decode(bytes.slice(0, 12));
        const mimeType = bytes[0] === 0x89 && signature.slice(1, 4) === "PNG" ? "image/png" : bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : signature.startsWith("GIF8") ? "image/gif" : signature.startsWith("RIFF") && signature.endsWith("WEBP") ? "image/webp" : null;
        if (!mimeType || bytes.length > 10 * 1024 * 1024) throw new Error("Invalid demo image");
        const attachmentId = crypto.randomUUID();
        const record = { id: attachmentId, mimeType, sizeBytes: bytes.length, absolutePath: `memory:${id}:${attachmentId}` };
        this.attachments.set(attachmentId, { record, bytes: bytes.slice() });
        return record;
      },
      resolve: async (attachmentId: string) => this.attachments.get(attachmentId)?.record ?? null,
    };
    this.chat = new DemoChatService(id, name, `demo-${generation}-${id}`,
      async (path, contents) => {
        if (!this.files.has(path)) throw new Error("Unknown in-memory document");
        if (contents === null) this.files.delete(path); else this.files.set(path, contents);
      }, attachmentStore.save);
    const terminalId = crypto.randomUUID();
    this.terminals.set(terminalId, { id: terminalId, createdAt: this.createdAt, attached: false, output: `\r\nSIMULATED TERMINAL — ${name}\r\ncheckout: ${path}\r\nNo shell commands are executed.\r\n${id}> ` });
    this.personal.lastPtyId = terminalId;
  }
  snapshot(): StatePayload {
    const rootId = `root-${this.id}`;
    return {
      workspaceApiRevision: 19, roots: [{ id: rootId, label: this.name, path: this.path, hiddenCount: 0,
        docs: [...this.files.keys()].map(relativePath => ({ id: `${this.id}:${relativePath}`, name: relativePath, relativePath, mtimeMs: this.createdAt, rootId, kind: "markdown" })) }],
      repositories: [], compareTarget: "base", initialFollow: false, defaultDocumentId: `${this.id}:README.md`,
      changedId: null, generatedAt: this.createdAt, build: { ...DEMO_BUILD, identifier: "simulation@mock", bundledWebRevision: 1 }, scope: { kind: "folder" }, terminal: "enabled",
    };
  }
  render(id: string, view: string | null) {
    const doc = this.snapshot().roots[0]!.docs.find(doc => doc.id === id);
    if (!doc) return null;
    const source = this.files.get(doc.relativePath)!;
    return { id, title: `${this.name} · ${doc.name}`, path: doc.relativePath, kind: "markdown", view: view === "source" ? "source" : "rendered", language: null,
      html: view === "source" ? `<pre><code>${escapeHtml(source)}</code></pre>` : `<h1>${escapeHtml(source.split("\n")[0]!.slice(2))}</h1><p>${escapeHtml(source.split("\n\n")[1]!)}</p>` };
  }
  dispose() { this.chat.reset(); this.attachments.clear(); this.terminals.clear(); }
}
