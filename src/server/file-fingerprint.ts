import type { Stats } from "node:fs";

// Private index data. Never attach this to DocumentMeta or a live payload.
export type FileFingerprint = Pick<Stats, "size" | "dev" | "ino" | "mtimeMs" | "ctimeMs">;
export function fileFingerprint(stats: FileFingerprint): FileFingerprint {
  return { size: stats.size, dev: stats.dev, ino: stats.ino, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}
export function sameFileFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.size === b.size && a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
