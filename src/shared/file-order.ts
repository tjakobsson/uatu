// Files and Preview use the same explicit order, independent of library defaults.
export function compareFileNames(left: string, right: string): number {
  const dot = Number(right.startsWith(".")) - Number(left.startsWith("."));
  return dot || left.toLowerCase().localeCompare(right.toLowerCase())
    || (left < right ? -1 : left > right ? 1 : 0);
}

export function compareTreeEntries(left: { segments: readonly string[]; isDirectory: boolean }, right: { segments: readonly string[]; isDirectory: boolean }): number {
  for (let i = 0; i < Math.min(left.segments.length, right.segments.length); i++) {
    const a = left.segments[i]!;
    const b = right.segments[i]!;
    if (a === b) continue;
    const aDir = i < left.segments.length - 1 || left.isDirectory;
    const bDir = i < right.segments.length - 1 || right.isDirectory;
    return aDir !== bDir ? (aDir ? -1 : 1) : compareFileNames(a, b);
  }
  return left.segments.length - right.segments.length;
}
