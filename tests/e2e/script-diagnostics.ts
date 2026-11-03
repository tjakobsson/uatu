// Pure, bounded failure-only metadata capture; no Playwright hooks here.
import { createHash } from "node:crypto";
export type ScriptResponse = {
  url: string;
  contentLength: string | null;
  readBody: () => Promise<Uint8Array>;
};

export class ScriptDiagnostics {
  private disposed = false;
  private readonly scripts = new Map<string, ScriptResponse>();
  private readonly captured = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly limits: {maxScripts:number; maxCaptures:number; maxBytes:number; deadlineMs:number};
  private readonly basePath: string;

  constructor(private readonly origin: string, private readonly record: (record: unknown) => void,
    options: Partial<{maxScripts:number; maxCaptures:number; maxBytes:number; deadlineMs:number; basePath:string}> = {}) {
    this.limits = {maxScripts:4, maxCaptures:2, maxBytes:20 * 1024 * 1024, deadlineMs:1000, ...options};
    this.basePath = options.basePath ?? "/";
  }

  private path(raw: string): string | null {
    try {
      const url = new URL(raw);
      const stripped = url.pathname.startsWith(this.basePath) ? "/" + url.pathname.slice(this.basePath.length) : "";
      // Under a Hub mount the shell's bundle refs carry the mount prefix only
      // (relocateShellHtml emits /s/<id>/chunk-….js, not /__uatu/asset), so the
      // actual mounted shape is normalized to the canonical asset namespace
      // before the allowlist. The prefix strip above keeps other sessions,
      // outside-of-prefix and nested paths out; the allowlist below stays
      // filename-scoped, so /api and arbitrary paths are still rejected.
      const path = this.basePath !== "/"
        && /^\/[A-Za-z0-9_.-]+-[a-z0-9]{8}\.js$/.test(stripped)
        ? "/__uatu/asset/" + stripped.slice(1)
        : stripped;
      return url.origin === this.origin && !url.username && !url.password
        && /^\/__uatu\/asset\/[A-Za-z0-9_.-]+-[a-z0-9]{8}\.js$/.test(path)
        ? path : null;
    } catch { return null; }
  }

  track(response: ScriptResponse): void {
    if (this.disposed) return;
    const path = this.path(response.url);
    if (path && !this.scripts.has(path) && this.scripts.size < this.limits.maxScripts) this.scripts.set(path, response);
  }

  pageError(error: {name:string; stack?:string}): void {
    if (this.disposed) return;
    if (this.captured.size >= this.limits.maxCaptures) return;
    // Inspect bounded stack text solely to locate a tracked resource. Never emit it.
    for (const match of (error.stack ?? "").slice(0, 8192).matchAll(/https?:\/\/[^\s)]+/g)) {
      const location = /^(.*):(\d{1,9}):(\d{1,9})$/.exec(match[0]);
      if (!location) continue;
      const path = this.path(location[1]!);
      const response = path ? this.scripts.get(path) : undefined;
      if (!path || !response || this.captured.has(path)) continue;
      this.captured.add(path);
      const metadata = {path, category:error.name === "SyntaxError" ? "SyntaxError" : "PageError", line:Number(location[2]), column:Number(location[3])};
      const task = this.capture(response, metadata);
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
      break;
    }
  }

  private async capture(response: ScriptResponse, metadata: object): Promise<void> {
    const unavailable = (reason: string) => ({...metadata, outcome:"unavailable", reason});
    const declared = response.contentLength;
    if (!declared || !/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > this.limits.maxBytes) {
      this.emit(unavailable("size")); return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    // Playwright cannot cancel/bound body() itself. The declared-length gate
    // avoids known large reads; actual size is rechecked, not a memory guarantee.
    const body = Promise.resolve().then(() => response.readBody()).then(bytes =>
      expired ? unavailable("deadline") : bytes.byteLength > this.limits.maxBytes ? unavailable("size")
        : {...metadata, outcome:"received", byteLength:bytes.byteLength, sha256:createHash("sha256").update(bytes).digest("hex")},
    () => unavailable("body"));
    const deadline = new Promise<object>(resolve => {timer = setTimeout(() => {expired = true; resolve(unavailable("deadline"));}, this.limits.deadlineMs);});
    try { this.emit(await Promise.race([body, deadline])); }
    finally { clearTimeout(timer); }
  }

  private emit(record: unknown): void {
    // Diagnostic failures must never replace the original page/test failure.
    try { this.record(record); } catch { /* best effort */ }
  }

  async flush(): Promise<void> { await Promise.all([...this.pending]); }

  // Already-started captures may finish, but retired navigations cannot
  // receive new responses/errors or retain their unused response bodies.
  dispose(): void { this.disposed = true; this.scripts.clear(); }
}
