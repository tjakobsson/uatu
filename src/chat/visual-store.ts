import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { loadIgnoreMatcher } from "../ignore/engine";
import { DEFAULT_RESPECT_GITIGNORE, shouldDenyPath, type WatchEntry } from "../server/roots";
import { resolveStaticFileRequest } from "../server/static-files";
import { resolveAttachmentStateRoot, sniffImageMime } from "./attachment-store";
import type { ChatVisualInput, ChatVisualSnapshot } from "./visual-types";
import { CHAT_VISUAL_ID_PATTERN, VISUAL_MAX_COUNT } from "./visual-types";
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
      // A file entry authorizes its named file, not every file in its parent.
      if (entry.kind === "file" && path.resolve(root, relative) !== entry.absolutePath) continue;
      if (shouldDenyPath(relative)) throw new VisualReadError();
      const matcher = await loadIgnoreMatcher({ rootPath: root, respectGitignore: respectGitignore ?? DEFAULT_RESPECT_GITIGNORE, isSingleFileRoot: entry.kind === "file" });
      if (matcher.shouldIgnore(relative)) continue;
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
      // The shared resolver permits contained symlinks for static files, but
      // captures do not. Bind its result to the candidate whose descendants
      // passed the no-symlink walk, even if a parent changed during resolution.
      if (resolved.filePath !== canonicalCandidate) throw new VisualReadError();
      const resolvedRealPath = await fs.realpath(resolved.filePath);
      if (resolvedRealPath !== canonicalCandidate || !containsVisualFile(canonicalWorkspace, resolvedRealPath)) throw new VisualReadError();
      const handle = await fs.open(resolved.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > VISUAL_MAX_BYTES) throw new VisualReadError();
        const again = await resolveStaticFileRequest(pathname, [entry], { respectGitignore });
        if (again.status !== "found" || again.filePath !== resolved.filePath) throw new VisualReadError();
        const currentRealPath = await fs.realpath(again.filePath);
        if (currentRealPath !== canonicalCandidate || !containsVisualFile(canonicalWorkspace, currentRealPath)) throw new VisualReadError();
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
  return parseSafeSvg(source) !== null;
}
type SafeSvgDocument = { body: string; rootOffset: number; hasNamespace: boolean };
function parseSafeSvg(source: string): SafeSvgDocument | null {
  source = svgDocumentBody(source);
  if (!source.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(source)) return null;
  const tags = new Set("svg g defs symbol use path rect circle ellipse line polyline polygon text tspan title desc style linearGradient radialGradient stop clipPath mask pattern marker".toLowerCase().split(" "));
  const stack: string[] = [];
  let document: SafeSvgDocument | null = null;
  let offset = 0;
  const styleText: string[] = [];
  const token = /<\/?[A-Za-z][^<>]*>/y;
  while (offset < source.length) {
    const start = source.indexOf("<", offset);
    if (start < 0) break;
    const between = source.slice(offset, start);
    if (/[<>]|\]\]>|&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/i.test(between) || (!stack.length && between.trim())) return null;
    if (stack.at(-1)?.toLowerCase() === "style") styleText.push(between);
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      if (end < 0) return null;
      // XML comments are tokens, not deletions that can repair malformed XML.
      const comment = source.slice(start + 4, end);
      if (comment.includes("--") || comment.endsWith("-")) return null;
      offset = end + 3;
      continue;
    }
    token.lastIndex = start;
    const match = token.exec(source);
    if (!match) return null;
    offset = token.lastIndex;
    const text = match[0];
    // Comments do not separate XML character data consumed by CSS.
    if (styleText.length) {
      if (!safeCss(styleText.join(""))) return null;
      styleText.length = 0;
    }
    const name = /^<\/?([A-Za-z][\w-]*)/.exec(text)?.[1];
    if (!name || !tags.has(name.toLowerCase())) return null;
    if (stack.at(-1)?.toLowerCase() === "style" && !text.startsWith("</")) return null;
    if (text.startsWith("</")) {
      if (!/^<\/[A-Za-z][\w-]*\s*>$/.test(text) || stack.pop() !== name) return null;
      continue;
    }
    const isRoot = stack.length === 0;
    if (isRoot) {
      if (document || name !== "svg") return null;
      document = { body: source, rootOffset: start, hasNamespace: false };
    }
    const selfClosing = text.endsWith("/>");
    let rest = text.slice(/^<[A-Za-z][\w-]*/.exec(text)![0].length, selfClosing ? -2 : -1).trimEnd();
    const seen = new Set<string>();
    while (rest) {
      const attr = /^\s+([A-Za-z][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
      if (!attr) return null;
      const key = attr[1]!.toLowerCase(), value = attr[2] ?? attr[3] ?? "";
      if (seen.has(key) || key.startsWith("on") || /[<&]/.test(value)) return null;
      seen.add(key);
      if (key === "xmlns") { if (value !== "http://www.w3.org/2000/svg") return null; }
      else if (key.includes(":")) return null;
      else if (key === "href") { if (!/^#[\w.-]+$/.test(value)) return null; }
      else if (!safeCss(value)) return null;
      if (isRoot && document && attr[1] === "xmlns") document.hasNamespace = true;
      rest = rest.slice(attr[0].length);
    }
    if (!selfClosing) stack.push(name);
  }
  return document && stack.length === 0 && !source.slice(offset).trim() ? document : null;
}
function svgDocumentBody(source: string): string {
  return source.replace(/^\s*<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"UTF-8"|'UTF-8'))?\s*\?>/i, "");
}
function safeCss(value: string): boolean {
  const segments: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    const start = value.indexOf("/*", offset);
    if (start < 0) break;
    const end = value.indexOf("*/", start + 2);
    if (end < 0) return false;
    segments.push(value.slice(offset, start));
    offset = end + 2;
  }
  segments.push(value.slice(offset));
  const css = segments.join("");
  return !/(?:url|image-set|cross-fade|paint|src)\s*\(|@|\\|&|expression|(?:https?|data|file|javascript|ftp|blob):|\/\//i.test(css.replace(/url\(\s*(?:#[\w.-]+|"#[\w.-]+"|'#[\w.-]+')\s*\)/gi, ""));
}

type RecordState = { sourceHash: string; snapshot: ChatVisualSnapshot; bytes?: string; sourceBytes?: string };
type VisualMetadata = Pick<RecordState, "sourceHash" | "snapshot"> & { hasBytes: boolean; hasSourceBytes: boolean };
export type StoredVisual = { bytes?: Uint8Array; mimeType: string; sourceBytes?: Uint8Array };
export type VisualCaptureRequest = { messageId: string; input: ChatVisualInput };
export class VisualStore {
  readonly directory: string;
  private reader: VisualFileReader = async () => { throw new VisualReadError(); };
  private readonly inflight = new Map<string, Promise<ChatVisualSnapshot>>();
  private activeOperations = 0;
  private readonly waitingOperations: Array<() => void> = [];
  // Repeated text deltas need only immutable metadata, not multi-MiB bytes.
  private readonly terminalMetadata = new Map<string, VisualMetadata>();
  private readonly metadataReads = new Map<string, Promise<VisualMetadata | null>>();
  // Only complete ledgers are immutable; partial groups must observe new slots.
  private readonly fullAdmissions = new Map<string, ReadonlySet<string>>();
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
    // These exact IDs already own permanent slots. Keep the reserved path
    // private, rather than rereading a partial ledger for every capture.
    const snapshots = await Promise.all([...selected].map(([id, { input }]) => this.captureOperation(id, input, () => this.captureOnce(id, input, streaming))
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
    const group = hash(JSON.stringify([conversationId, messageId]));
    const cached = this.fullAdmissions.get(group);
    if (cached) return cached.has(id);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const owners = new Set<string>();
    for (let slot = 0; slot < VISUAL_MAX_COUNT; slot++) {
      const filename = path.join(this.directory, `${group}.slot-${slot}.json`);
      let owner: string;
      try {
        owner = await fs.readFile(filename, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.publishIfAbsent(filename, id);
        owner = await fs.readFile(filename, "utf8");
      }
      owners.add(owner);
      if (slot === VISUAL_MAX_COUNT - 1) {
        if (this.fullAdmissions.size >= 512) this.fullAdmissions.delete(this.fullAdmissions.keys().next().value!);
        this.fullAdmissions.set(group, owners);
      }
      if (owner === id) return true;
    }
    return false;
  }
  async capture(conversationId: string, messageId: string, input: ChatVisualInput, streaming: boolean, admissionMessageId = messageId): Promise<ChatVisualSnapshot> {
    const id = this.captureId(conversationId, messageId, input);
    return this.captureOperation(id, input, async () => await this.reserve(conversationId, admissionMessageId, id)
      ? this.captureOnce(id, input, streaming)
      : { index: input.index, status: "unavailable" as const, message: "Image limit exceeded" });
  }
  private async captureOperation(id: string, input: ChatVisualInput, operation: () => Promise<ChatVisualSnapshot>): Promise<ChatVisualSnapshot> {
    if (!Number.isSafeInteger(input.index) || input.index < 0) return { index: input.index, status: "unavailable", message: "Invalid image index" };
    // Wait outside admission: duplicate callers must not occupy all permits
    // while waiting for the capture whose permit they need to complete.
    while (this.inflight.has(id)) await this.inflight.get(id);
    const task = this.admitted(operation);
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
        const document = parseSafeSvg(svg);
        if (!document) {
          record = { sourceHash, snapshot: { index: input.index, status: "unavailable", id, mimeType, message: "SVG preview is unavailable or not allowed" }, sourceBytes: Buffer.from(bytes).toString("base64") };
        } else {
          // Fenced fragments commonly omit the XML namespace. Add it only to
          // the image document, retaining the exact original for source/copy.
          const offset = document.rootOffset + "<svg".length;
          const body = document.hasNamespace ? document.body
            : document.body.slice(0, offset) + ' xmlns="http://www.w3.org/2000/svg"' + document.body.slice(offset);
          preview = new TextEncoder().encode(body);
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
    const published = await this.publishIfAbsent(path.join(this.directory, `${id}${suffix}.json`), JSON.stringify(record));
    // Only the canonical winner may supply derived bytes. A winning writer
    // already has that record in memory and need not parse its base64 JSON.
    if (published && !suffix) {
      await this.materializeMetadata(id, record);
      return record.snapshot;
    }
    // A terminal loser knows the canonical record exists; do not join a
    // metadata lookup that may have started before that publication.
    const winner = (await (suffix ? this.readMetadata(id) : this.loadMetadata(id))) ?? (await this.readRecord(id, ".pending"))!;
    return winner.sourceHash === record.sourceHash ? winner.snapshot : { index, status: "unavailable", message: "Image source changed" };
  }
  private async publishIfAbsent(filename: string, content: string | Uint8Array): Promise<boolean> {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      try { await fs.link(temporary, filename); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; return false; }
    } finally { await fs.unlink(temporary).catch(() => undefined); }
  }
  private async readRecord(id: string, suffix = ""): Promise<RecordState | null> {
    if (!CHAT_VISUAL_ID_PATTERN.test(id)) return null;
    try { return JSON.parse(await fs.readFile(path.join(this.directory, `${id}${suffix}.json`), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private async materializeMetadata(id: string, record: RecordState): Promise<VisualMetadata> {
    const metadata: VisualMetadata = {
      sourceHash: record.sourceHash, snapshot: record.snapshot,
      hasBytes: record.snapshot.status === "ready" && record.bytes !== undefined,
      hasSourceBytes: record.snapshot.mimeType === "image/svg+xml" && record.sourceBytes !== undefined,
    };
    // Fixed filenames derive only from the validated occurrence ID, never
    // from fields in persisted JSON. All writers derive from the same winner.
    // Publish raw files before metadata: interrupted materialization can be
    // resumed without exposing partial or competing-writer content.
    try {
      if (metadata.hasBytes) await this.publishIfAbsent(path.join(this.directory, `${id}.preview.bin`), Buffer.from(record.bytes!, "base64"));
      if (metadata.hasSourceBytes) await this.publishIfAbsent(path.join(this.directory, `${id}.source.bin`), Buffer.from(record.sourceBytes!, "base64"));
      await this.publishIfAbsent(path.join(this.directory, `${id}.metadata.json`), JSON.stringify(metadata));
    } catch {
      // Derived caches are optional: read-only legacy state or an interrupted
      // sidecar write must not change the canonical winner's availability.
      // Until materialization succeeds, byte reads fall back to legacy JSON.
    }
    return metadata;
  }
  private async readMetadata(id: string): Promise<VisualMetadata | null> {
    if (!CHAT_VISUAL_ID_PATTERN.test(id)) return null;
    const cached = this.terminalMetadata.get(id);
    if (cached) return cached;
    const inflight = this.metadataReads.get(id);
    if (inflight) return inflight;
    const task = this.loadMetadata(id);
    this.metadataReads.set(id, task);
    try { return await task; }
    finally { this.metadataReads.delete(id); }
  }
  private async loadMetadata(id: string): Promise<VisualMetadata | null> {
    let metadata: VisualMetadata;
    try { metadata = JSON.parse(await fs.readFile(path.join(this.directory, `${id}.metadata.json`), "utf8")); }
    catch {
      // Legacy canonical files remain authoritative and untouched. Their
      // first read needs one large JSON parse to create small/raw sidecars;
      // subsequent history loads and GETs need only the derived files.
      const record = await this.readRecord(id);
      if (!record) return null;
      metadata = await this.materializeMetadata(id, record);
    }
    if (this.terminalMetadata.size >= 512) this.terminalMetadata.delete(this.terminalMetadata.keys().next().value!);
    this.terminalMetadata.set(id, metadata);
    return metadata;
  }
  async resolve(id: string): Promise<StoredVisual | null> {
    return this.admitted(() => this.resolveOnce(id));
  }
  private async resolveOnce(id: string): Promise<StoredVisual | null> {
    const metadata = await this.readMetadata(id);
    if (!metadata?.snapshot.mimeType) return null;
    try {
      const sourceBytes = metadata.snapshot.mimeType === "image/svg+xml" && metadata.hasSourceBytes === true
        ? await fs.readFile(path.join(this.directory, `${id}.source.bin`)) : undefined;
      const bytes = metadata.snapshot.status === "ready" && metadata.hasBytes === true
        ? await fs.readFile(path.join(this.directory, `${id}.preview.bin`)) : undefined;
      return bytes || sourceBytes ? { mimeType: metadata.snapshot.mimeType, ...(bytes ? { bytes } : {}), ...(sourceBytes ? { sourceBytes } : {}) } : null;
    } catch {
      // Missing/unreadable derived bytes never make preserved legacy bytes
      // inaccessible. Repair from the authoritative record when possible.
      const record = await this.readRecord(id);
      if (!record?.snapshot.mimeType) return null;
      await this.materializeMetadata(id, record);
      const sourceBytes = record.snapshot.mimeType === "image/svg+xml" && record.sourceBytes !== undefined ? Buffer.from(record.sourceBytes, "base64") : undefined;
      const bytes = record.snapshot.status === "ready" && record.bytes !== undefined ? Buffer.from(record.bytes, "base64") : undefined;
      return bytes || sourceBytes ? { mimeType: record.snapshot.mimeType, ...(bytes ? { bytes } : {}), ...(sourceBytes ? { sourceBytes } : {}) } : null;
    }
  }
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
