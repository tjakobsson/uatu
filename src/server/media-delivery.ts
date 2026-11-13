import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { loadIgnoreMatcher } from "../ignore/engine";
import { mediaMimeType } from "../shared/media";
import type { RevisionedDocument } from "../shared/document-updates";
import type { MetricsRegistry } from "../debug/metrics";
import type { WatchEntry } from "./roots";
import { sameFileFingerprint, type FileFingerprint } from "./file-fingerprint";

export const MEDIA_CHUNK_BYTES = 64 * 1024;
const cacheHeaders = { "cache-control": "no-store, no-transform" };
const refused = (status: number) => new Response(null, { status, headers: { ...cacheHeaders, "content-length": "0" } });
type IndexedMedia = { doc: RevisionedDocument; entry: WatchEntry; fingerprint: FileFingerprint | null };
type Transfer = { rootId: string; id: string; abort: () => void };

function contained(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// Malformed/multiple ranges select the full representation. BigInt keeps
// arbitrarily large decimal bounds well-defined without rounding file offsets.
export function mediaRange(value: string | null, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !match[1] && !match[2]) return null;
  const total = BigInt(size);
  if (!match[1]) {
    const suffix = BigInt(match[2]!);
    if (!suffix || !total) return "unsatisfiable";
    return { start: Number(suffix >= total ? 0n : total - suffix), end: size - 1 };
  }
  const start = BigInt(match[1]);
  const end = match[2] ? BigInt(match[2]) : total - 1n;
  if (match[2] && end < start) return null;
  if (start >= total) return "unsatisfiable";
  return { start: Number(start), end: Number(end >= total ? total - 1n : end) };
}

export class MediaDelivery {
  private transfers = new Set<Transfer>();
  private stopped = false;
  constructor(private options: {
    epoch: string;
    lookup: (rootId: string, relativePath: string) => IndexedMedia | undefined;
    metrics?: MetricsRegistry;
  }) {}

  invalidate(rootId: string, id?: string, descendants = false): void {
    for (const transfer of this.transfers) {
      if (transfer.rootId === rootId && (id === undefined || transfer.id === id || descendants && contained(id, transfer.id))) transfer.abort();
    }
  }
  stop(): void { this.stopped = true; for (const transfer of this.transfers) transfer.abort(); }

  async response(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams;
    for (const name of ["rootId", "path", "epoch", "revision"]) if (params.getAll(name).length !== 1 || !params.get(name)) return refused(400);
    const rootId = params.get("rootId")!, relative = params.get("path")!, epoch = params.get("epoch")!;
    const revisionText = params.get("revision")!;
    if (!/^\d+$/.test(revisionText) || !Number.isSafeInteger(Number(revisionText))
      || relative.includes("\\") || relative.includes("\0") || relative.split("/").some(part => !part || part === "." || part === "..")) return refused(400);
    if (this.stopped || epoch !== this.options.epoch) return refused(409);
    const indexed = this.options.lookup(rootId, relative);
    if (!indexed) return refused(404);
    const { doc, entry, fingerprint } = indexed;
    const mime = mediaMimeType(doc.name);
    if (!mime || doc.kind !== "binary") return refused(404);
    if (doc.revision !== Number(revisionText) || !fingerprint) return refused(409);
    const current = () => {
      const now = this.options.lookup(rootId, relative);
      return !this.stopped && now?.doc.revision === doc.revision && now.fingerprint !== null && sameFileFingerprint(fingerprint, now.fingerprint);
    };
    let handle: FileHandle | undefined;
    let done = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const metrics = this.options.metrics;
    const finish = async (error?: Error) => {
      if (done) return;
      done = true;
      this.transfers.delete(transfer);
      request.signal.removeEventListener("abort", transfer.abort);
      metrics?.inc("media.transfers_active", -1);
      if (error && controller) controller.error(error);
      if (handle) { const owned = handle; handle = undefined; await owned.close().catch(() => {}); metrics?.inc("media.open_handles", -1); }
    };
    const transfer: Transfer = { rootId, id: doc.id, abort: () => { void finish(new Error("Media transfer invalidated or cancelled")); } };
    this.transfers.add(transfer);
    metrics?.inc("media.transfers_active");
    request.signal.addEventListener("abort", transfer.abort, { once: true });
    if (request.signal.aborted) transfer.abort();
    try {
      const base = entry.kind === "dir" ? entry.absolutePath : entry.parentDir;
      const matcher = await loadIgnoreMatcher({ rootPath: base, respectGitignore: true, isSingleFileRoot: entry.kind === "file" });
      if (matcher.shouldIgnore(relative)) { await finish(); return refused(404); }
      const [realBase, realFile] = await Promise.all([realpath(base), realpath(doc.id)]);
      if (!contained(realBase, realFile)) { await finish(); return refused(404); }
      let segmentPath = base;
      for (const segment of relative.split("/")) {
        segmentPath = path.join(segmentPath, segment);
        if ((await lstat(segmentPath)).isSymbolicLink()) { await finish(); return refused(404); }
      }
      if (done || !current()) { await finish(); return refused(409); }
      const opened = await open(doc.id, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      // Cancellation can precede open's completion. That handle still belongs
      // here and must be closed, rather than being installed after finish().
      if (done) { await opened.close(); return refused(409); }
      handle = opened;
      metrics?.inc("media.open_handles");
      const stats = await handle.stat();
      const afterPath = await realpath(doc.id);
      if (done || !stats.isFile() || !sameFileFingerprint(fingerprint, stats) || !contained(realBase, afterPath) || !current()) {
        await finish(); return refused(409);
      }
      const range = request.method === "HEAD" ? null : mediaRange(request.headers.get("range"), stats.size);
      const headers = new Headers({ ...cacheHeaders, "content-type": mime, "accept-ranges": "bytes" });
      if (range === "unsatisfiable") {
        headers.set("content-range", `bytes */${stats.size}`); headers.set("content-length", "0");
        await finish(); return new Response(null, { status: 416, headers });
      }
      let position = range?.start ?? 0;
      const end = range?.end ?? stats.size - 1;
      headers.set("content-length", String(Math.max(0, end - position + 1)));
      if (range) headers.set("content-range", `bytes ${position}-${end}/${stats.size}`);
      const status = range ? 206 : 200;
      if (request.method === "HEAD" || !stats.size) { await finish(); return new Response(null, { status, headers }); }
      const body = new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        async pull(value) {
          if (done) return;
          try {
            if (!current()) throw new Error("Stale media revision");
            const file = handle!;
            const buffer = new Uint8Array(Math.min(MEDIA_CHUNK_BYTES, end - position + 1));
            const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
            metrics?.inc("media.read_calls_total"); metrics?.inc("media.read_bytes_total", bytesRead);
            if (done) return;
            if (!bytesRead || !sameFileFingerprint(fingerprint, await file.stat()) || !current()) throw new Error("Media changed during delivery");
            if (done) return;
            position += bytesRead;
            value.enqueue(buffer.subarray(0, bytesRead));
            if (position > end) { value.close(); await finish(); }
          } catch (error) { await finish(error instanceof Error ? error : new Error(String(error))); }
        },
        cancel: () => finish(),
      }, { highWaterMark: 0 });
      return new Response(body, { status, headers });
    } catch (error) {
      await finish();
      const code = (error as NodeJS.ErrnoException).code;
      return refused(code === "EACCES" || code === "EPERM" || code === "ELOOP" ? 404 : 409);
    }
  }
}
