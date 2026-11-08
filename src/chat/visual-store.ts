import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { loadIgnoreMatcher } from "../ignore/engine";
import { DEFAULT_RESPECT_GITIGNORE, shouldDenyPath, type WatchEntry } from "../server/roots";
import { resolveStaticFileRequest } from "../server/static-files";
import { resolveAttachmentStateRoot, sniffImageMime } from "./attachment-store";
import type { ChatVisualInput, ChatVisualSnapshot } from "./visual-types";
import { VISUAL_MAX_COUNT } from "./visual-types";
export { VISUAL_MAX_COUNT } from "./visual-types";

export const VISUAL_MAX_BYTES = 10 * 1024 * 1024;
export const VISUAL_CAPTURE_CONCURRENCY = 4;
export const VISUAL_CSP = "sandbox; default-src 'none'; img-src 'none'; style-src 'unsafe-inline'";
export type VisualFileReader = (source: string, workspacePath: string) => Promise<Uint8Array>;
export class VisualReadError extends Error {
  constructor(readonly missing = false) { super(missing ? "Image file not available yet" : "Image is unavailable or not allowed"); }
}

// Resolve relative to the workspace, never to a rendered document or URL.
// Reuse the static-file policy and recheck the opened inode before a bounded read.
export function createWatchedVisualReader(entries: WatchEntry[], respectGitignore?: boolean): VisualFileReader {
  return async (source, workspacePath) => {
    if (!source || /[\0\\?#]/.test(source) || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source)) throw new VisualReadError();
    let decoded: string;
    try { decoded = decodeURIComponent(source); } catch { throw new VisualReadError(); }
    if (/[\0\\?#]/.test(decoded) || decoded.split("/").includes("..")) throw new VisualReadError();
    const workspace = path.resolve(workspacePath);
    const candidate = path.resolve(workspace, decoded);
    if (!containsVisualFile(workspace, candidate)) throw new VisualReadError();
    let canonicalWorkspace: string;
    try { canonicalWorkspace = await fs.realpath(workspace); }
    catch { throw new VisualReadError(); }
    // Normalize only the trusted workspace/root aliases, not descendant paths:
    // those still need lexical ignore checks and the no-symlink walk below.
    const canonicalCandidate = path.resolve(canonicalWorkspace, path.relative(workspace, candidate));
    for (const entry of entries) {
      const root = entry.kind === "dir" ? entry.absolutePath : entry.parentDir;
      const canonicalRoot = await fs.realpath(root).catch(() => null);
      if (!canonicalRoot) continue;
      const relative = path.relative(canonicalRoot, canonicalCandidate);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      if (shouldDenyPath(relative)) throw new VisualReadError();
      const matcher = await loadIgnoreMatcher({ rootPath: root, respectGitignore: respectGitignore ?? DEFAULT_RESPECT_GITIGNORE });
      if (matcher.shouldIgnore(relative)) throw new VisualReadError();
      let currentPath = root;
      for (const segment of relative.split(path.sep)) {
        currentPath = path.join(currentPath, segment);
        const stat = await visualLstat(currentPath);
        if (stat?.isSymbolicLink()) throw new VisualReadError();
      }
      const pathname = relative.split(path.sep).map(encodeURIComponent).join("/");
      const resolved = await resolveStaticFileRequest(pathname, [entry], { respectGitignore });
      if (resolved.status !== "found") {
        // A symlink (including an escaped parent), directory or denied path is
        // permanent; only a genuinely absent path may be retried at completion.
        const stat = await visualLstat(candidate);
        throw new VisualReadError(stat === null);
      }
      if (!containsVisualFile(canonicalWorkspace, await fs.realpath(resolved.filePath))) throw new VisualReadError();
      const handle = await fs.open(resolved.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > VISUAL_MAX_BYTES) throw new VisualReadError();
        const again = await resolveStaticFileRequest(pathname, [entry], { respectGitignore });
        if (again.status !== "found" || again.filePath !== resolved.filePath) throw new VisualReadError();
        if (!containsVisualFile(canonicalWorkspace, await fs.realpath(again.filePath))) throw new VisualReadError();
        const current = await fs.stat(again.filePath);
        if (current.dev !== before.dev || current.ino !== before.ino) throw new VisualReadError();
        // One extra byte detects growth without allocating the full limit for
        // every tiny file. Any mutation during capture is refused, not retried
        // through unbounded buffer growth.
        const bytes = new Uint8Array(Math.min(before.size + 1, VISUAL_MAX_BYTES + 1));
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        const after = await handle.stat();
        if (length !== before.size || length > VISUAL_MAX_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new VisualReadError();
        return bytes.slice(0, length);
      } finally { await handle.close(); }
    }
    throw new VisualReadError();
  };
}
function containsVisualFile(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function visualLstat(filename: string) {
  try { return await fs.lstat(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new VisualReadError();
  }
}

// A deliberately conservative XML subset. No HTML recovery, DTDs, processing
// instructions, active elements, non-SVG namespaces, external CSS resources or
// entity expansion.
// The preview remains an image document under CSP, never inline DOM.
export function isSafeSvg(source: string): boolean {
  source = svgDocumentBody(source);
  if (!source.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f]|\]\]>|<!|<\?|&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/i.test(source)) return false;
  const tags = new Set("svg g defs symbol use path rect circle ellipse line polyline polygon text tspan title desc style linearGradient radialGradient stop clipPath mask pattern marker".toLowerCase().split(" "));
  const stack: string[] = [];
  let root = false;
  let offset = 0;
  const token = /<\/?[A-Za-z][^<>]*>/g;
  for (const match of source.matchAll(token)) {
    const between = source.slice(offset, match.index);
    if (/[<>]/.test(between) || (!stack.length && between.trim())) return false;
    if (stack.at(-1)?.toLowerCase() === "style" && !safeCss(between)) return false;
    offset = match.index! + match[0].length;
    const text = match[0];
    const name = /^<\/?([A-Za-z][\w-]*)/.exec(text)?.[1];
    if (!name || !tags.has(name.toLowerCase())) return false;
    if (text.startsWith("</")) {
      if (!/^<\/[A-Za-z][\w-]*\s*>$/.test(text) || stack.pop() !== name) return false;
      continue;
    }
    if (!stack.length) { if (root || name !== "svg") return false; root = true; }
    let rest = text.slice(/^<[A-Za-z][\w-]*/.exec(text)![0].length).replace(/\/?\s*>$/, "");
    const seen = new Set<string>();
    while (rest.trim()) {
      const attr = /^\s+([A-Za-z][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
      if (!attr) return false;
      const key = attr[1]!.toLowerCase(), value = attr[2] ?? attr[3] ?? "";
      if (seen.has(key) || key.startsWith("on") || /[<&]/.test(value)) return false;
      seen.add(key);
      if (key === "xmlns") { if (value !== "http://www.w3.org/2000/svg") return false; }
      else if (key.includes(":")) return false;
      else if (key === "href") { if (!/^#[\w.-]+$/.test(value)) return false; }
      else if (!safeCss(value)) return false;
      rest = rest.slice(attr[0].length);
    }
    if (!/\/\s*>$/.test(text)) stack.push(name);
  }
  return root && stack.length === 0 && !source.slice(offset).trim();
}
function svgDocumentBody(source: string): string {
  return source.replace(/^\s*<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"UTF-8"|'UTF-8'))?\s*\?>/i, "")
    .replace(/<!--(?:[^-]|-(?!-))*-->/g, "");
}
function safeCss(value: string): boolean {
  return !/(?:url|image-set|cross-fade|paint|src)\s*\(|@|\\|&|expression|(?:https?|data|file|javascript|ftp|blob):|\/\//i.test(value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/url\(\s*(?:#[\w.-]+|"#[\w.-]+"|'#[\w.-]+')\s*\)/gi, ""));
}

type RecordState = { sourceHash: string; snapshot: ChatVisualSnapshot; bytes?: string; sourceBytes?: string };
export type StoredVisual = { bytes?: Uint8Array; mimeType: string; sourceBytes?: Uint8Array };
export type VisualCaptureRequest = { messageId: string; input: ChatVisualInput };
export class VisualStore {
  readonly directory: string;
  private reader: VisualFileReader = async () => { throw new VisualReadError(); };
  private readonly inflight = new Map<string, Promise<ChatVisualSnapshot>>();
  private activeOperations = 0;
  private readonly waitingOperations: Array<() => void> = [];
  // Repeated text deltas need only immutable metadata, not multi-MiB bytes.
  private readonly terminalMetadata = new Map<string, Pick<RecordState, "sourceHash" | "snapshot">>();
  constructor(private readonly workspacePath: string, root = path.join(path.dirname(resolveAttachmentStateRoot()), "visuals")) {
    this.directory = path.join(root, hash(path.resolve(workspacePath)));
  }
  setReader(reader: VisualFileReader): void { this.reader = reader; }
  private async admitted<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeOperations >= VISUAL_CAPTURE_CONCURRENCY) {
      await new Promise<void>(resolve => this.waitingOperations.push(resolve));
    } else {
      this.activeOperations++;
    }
    try { return await operation(); }
    finally {
      // Transfer the held permit directly to the next waiter; new callers
      // cannot overtake it or exceed the shared instance-wide bound.
      const next = this.waitingOperations.shift();
      if (next) next();
      else this.activeOperations--;
    }
  }
  /** Only permanent reservations ride the wire; absent occurrences are refused.
   * First processing establishes admissions without scanning prior captures.
   * Retain at most eight requests and never queue all parser output.
   */
  async captureMany(conversationId: string, admissionMessageId: string, requests: Iterable<VisualCaptureRequest>, streaming: boolean): Promise<ChatVisualSnapshot[]> {
    const selected = new Map<string, VisualCaptureRequest>();
    for (const request of requests) {
      const id = this.captureId(conversationId, request.messageId, request.input);
      if (!selected.has(id) && await this.admitted(() => this.reserve(conversationId, admissionMessageId, id))) selected.set(id, request);
      if (selected.size === VISUAL_MAX_COUNT) break;
    }
    const snapshots = await Promise.all([...selected.values()].map(({ messageId, input }) => this.capture(conversationId, messageId, input, streaming, admissionMessageId)
      .catch(() => ({ index: input.index, status: "unavailable" as const, message: "Image snapshot could not be stored" }))));
    return snapshots.sort((a, b) => a.index - b.index);
  }
  private captureId(conversationId: string, messageId: string, input: ChatVisualInput): string {
    return hash(JSON.stringify([conversationId, messageId, input.key ?? String(input.index)]));
  }
  // Eight immutable slot files are an append-only admission ledger. link's
  // no-overwrite semantics serialize independent processes without stale locks:
  // a crash keeps the reservation, never frees a slot for a ninth occurrence.
  private async reserve(conversationId: string, messageId: string, id: string): Promise<boolean> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const group = hash(JSON.stringify([conversationId, messageId]));
    for (let slot = 0; slot < VISUAL_MAX_COUNT; slot++) {
      const filename = path.join(this.directory, `${group}.slot-${slot}.json`);
      try {
        if (await fs.readFile(filename, "utf8") === id) return true;
        continue;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await this.publishIfAbsent(filename, id);
      if (await fs.readFile(filename, "utf8") === id) return true;
    }
    return false;
  }
  async capture(conversationId: string, messageId: string, input: ChatVisualInput, streaming: boolean, admissionMessageId = messageId): Promise<ChatVisualSnapshot> {
    if (!Number.isSafeInteger(input.index) || input.index < 0) return { index: input.index, status: "unavailable", message: "Invalid image index" };
    const id = this.captureId(conversationId, messageId, input);
    // Wait outside admission: duplicate callers must not occupy all permits
    // while waiting for the capture whose permit they need to complete.
    while (this.inflight.has(id)) await this.inflight.get(id);
    const task = this.admitted(async () => await this.reserve(conversationId, admissionMessageId, id)
      ? this.captureOnce(id, input, streaming)
      : { index: input.index, status: "unavailable" as const, message: "Image limit exceeded" });
    this.inflight.set(id, task);
    try { return { ...await task, index: input.index }; }
    finally { this.inflight.delete(id); }
  }
  private async captureOnce(id: string, input: ChatVisualInput, streaming: boolean): Promise<ChatVisualSnapshot> {
    const sourceHash = hash(JSON.stringify([input.kind, input.source]));
    const prior = await this.readMetadata(id);
    if (prior && prior.sourceHash !== sourceHash) return { index: input.index, status: "unavailable", message: "Image source changed" };
    if (prior) return prior.snapshot;
    const pending = await this.readRecord(id, ".pending");
    if (pending && pending.sourceHash !== sourceHash) return { index: input.index, status: "unavailable", message: "Image source changed" };
    if (pending && streaming) return pending.snapshot;
    if (!input.complete) {
      if (streaming) return { index: input.index, status: "pending" };
      return this.publishRecord(id, { sourceHash, snapshot: { index: input.index, status: "unavailable", message: "SVG block is unfinished" } }, input.index);
    }
    let record: RecordState;
    try {
      const bytes = input.kind === "svg" ? new TextEncoder().encode(input.source) : await this.reader(input.source, this.workspacePath);
      if (bytes.length > VISUAL_MAX_BYTES) throw new VisualReadError();
      let mimeType = sniffImageMime(bytes);
      let preview = bytes;
      if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
        // Extension/fence identifies a source candidate; content sniffing must
        // never turn arbitrary non-image workspace text into a download route.
        if (input.kind !== "svg" && path.extname(decodeURIComponent(input.source)).toLowerCase() !== ".svg") throw new VisualReadError();
        const svg = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        mimeType = "image/svg+xml";
        if (!isSafeSvg(svg)) {
          record = { sourceHash, snapshot: { index: input.index, status: "unavailable", id, mimeType, message: "SVG preview is unavailable or not allowed" }, sourceBytes: Buffer.from(bytes).toString("base64") };
        } else {
          // Fenced fragments commonly omit the XML namespace. Add it only to
          // the image document, retaining the exact original for source/copy.
          const body = svgDocumentBody(svg);
          const opening = /<svg(?=[\s/>])[^>]*>/.exec(body)?.[0] ?? "";
          const hasNamespace = [...opening.matchAll(/\s+([\w:.-]+)\s*=\s*(?:"[^"]*"|'[^']*')/g)].some(match => match[1] === "xmlns");
          if (!hasNamespace) {
            preview = new TextEncoder().encode(body.replace(/<svg(?=[\s/>])/, '<svg xmlns="http://www.w3.org/2000/svg"'));
          } else preview = new TextEncoder().encode(body);
          record = { sourceHash, snapshot: { index: input.index, status: "ready", id, mimeType }, bytes: Buffer.from(preview).toString("base64"), sourceBytes: Buffer.from(bytes).toString("base64") };
        }
      } else {
        record = { sourceHash, snapshot: { index: input.index, status: "ready", id, mimeType }, bytes: Buffer.from(preview).toString("base64") };
      }
    } catch (error) {
      record = streaming && error instanceof VisualReadError && error.missing
        ? { sourceHash, snapshot: { index: input.index, status: "pending" } }
        : { sourceHash, snapshot: { index: input.index, status: "unavailable", message: "Image is unavailable or not allowed" } };
    }
    return this.publishRecord(id, record, input.index);
  }
  private async publishRecord(id: string, record: RecordState, index: number): Promise<ChatVisualSnapshot> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Publish a complete record atomically with link's no-overwrite semantics.
    // Other processes/readers and restarts see exactly the first winner.
    const suffix = record.snapshot.status === "pending" ? ".pending" : "";
    await this.publishIfAbsent(path.join(this.directory, `${id}${suffix}.json`), JSON.stringify(record));
    const winner = (await this.readMetadata(id)) ?? (await this.readRecord(id, ".pending"))!;
    return winner.sourceHash === record.sourceHash ? winner.snapshot : { index, status: "unavailable", message: "Image source changed" };
  }
  private async publishIfAbsent(filename: string, content: string): Promise<void> {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      await fs.link(temporary, filename).catch(error => { if (error.code !== "EEXIST") throw error; });
    } finally { await fs.unlink(temporary).catch(() => undefined); }
  }
  private async readRecord(id: string, suffix = ""): Promise<RecordState | null> {
    if (!/^[a-f\d]{64}$/.test(id)) return null;
    try { return JSON.parse(await fs.readFile(path.join(this.directory, `${id}${suffix}.json`), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private async readMetadata(id: string): Promise<Pick<RecordState, "sourceHash" | "snapshot"> | null> {
    const cached = this.terminalMetadata.get(id);
    if (cached) return cached;
    const record = await this.readRecord(id);
    if (!record) return null;
    const metadata = { sourceHash: record.sourceHash, snapshot: record.snapshot };
    if (this.terminalMetadata.size >= 512) this.terminalMetadata.delete(this.terminalMetadata.keys().next().value!);
    this.terminalMetadata.set(id, metadata);
    return metadata;
  }
  async resolve(id: string): Promise<StoredVisual | null> {
    return this.admitted(() => this.resolveOnce(id));
  }
  private async resolveOnce(id: string): Promise<StoredVisual | null> {
    const record = await this.readRecord(id);
    if (!record?.snapshot.mimeType) return null;
    const sourceBytes = record.snapshot.mimeType === "image/svg+xml" && record.sourceBytes !== undefined
      ? Buffer.from(record.sourceBytes, "base64") : undefined;
    const bytes = record.snapshot.status === "ready" && record.bytes !== undefined ? Buffer.from(record.bytes, "base64") : undefined;
    return bytes || sourceBytes ? { mimeType: record.snapshot.mimeType, ...(bytes ? { bytes } : {}), ...(sourceBytes ? { sourceBytes } : {}) } : null;
  }
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
