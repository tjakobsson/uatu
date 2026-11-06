import { mediaKind } from "../shared/media";
import type { DocumentMeta } from "../shared/types";

export type FilesMediaType = "all" | "audio" | "video";
export function matchesMediaType(doc: DocumentMeta, type: FilesMediaType): boolean {
  return type === "all" || mediaKind(doc.name) === type;
}

const textOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function segmentOrder(a: string, b: string): number {
  const left = a.toLowerCase().match(/\d+|\D+/g) ?? [];
  const right = b.toLowerCase().match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]!, y = right[i]!;
    const order = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : textOrder(x, y);
    if (order) return order;
  }
  return left.length - right.length || textOrder(a.toLowerCase(), b.toLowerCase()) || textOrder(a, b);
}

// Pierre's default hierarchy is directories first and natural/case-insensitive
// within siblings. Capture that order without expanding/collapsing its model or
// creating another FileTree. Closed folders still contribute eligible files.
export function compareTreePaths(a: string, b: string): number {
  const left = a.split("/"), right = b.split("/");
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] === right[i]) continue;
    const leftDirectory = i < left.length - 1, rightDirectory = i < right.length - 1;
    if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
    return segmentOrder(left[i]!, right[i]!);
  }
  return left.length - right.length;
}
