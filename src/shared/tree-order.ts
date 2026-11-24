// The one order for a pull request's changed files, wherever they are
// listed (the Files pane's PR scope, Files changed, its Jump to file list):
// tree order. At every folder level folders come before files, dot-names
// before others, then names case-insensitively, which is the order
// `@pierre/trees` (the Files pane's tree) shows by default.

export function compareTreePaths(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const leftName = left[index]!;
    const rightName = right[index]!;
    const leftFile = index === left.length - 1;
    const rightFile = index === right.length - 1;
    if (leftName === rightName && !leftFile && !rightFile) continue;
    if (leftFile !== rightFile) return leftFile ? 1 : -1;
    const leftDot = leftName.startsWith(".");
    if (leftDot !== rightName.startsWith(".")) return leftDot ? -1 : 1;
    const byName = leftName.toLowerCase().localeCompare(rightName.toLowerCase());
    if (byName !== 0) return byName;
    if (leftName !== rightName) return leftName < rightName ? -1 : 1;
  }
  return left.length - right.length;
}

export function inTreeOrder<T extends { path: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => compareTreePaths(a.path, b.path));
}
