// The server resolves explicit CLI/project legacy defaults. A saved personal
// value always wins; absent/invalid defaults show the permitted inventory.
export function resolveIgnoredVisibility(saved: unknown, initial: unknown): boolean {
  return typeof saved === "boolean" ? saved : typeof initial === "boolean" ? initial : true;
}
