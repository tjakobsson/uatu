import path from "node:path";

export function normalizeAbsolutePath(value: string): string {
  return path.normalize(path.resolve(value));
}

export function isPathAtOrBelow(candidate: string, parent: string): boolean {
  const relative = path.relative(normalizeAbsolutePath(parent), normalizeAbsolutePath(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function pathsOverlap(first: string, second: string): boolean {
  return isPathAtOrBelow(first, second) || isPathAtOrBelow(second, first);
}

export type PathReservation = {
  readonly paths: readonly string[];
  release(): void;
};

export class PathReservationCoordinator {
  private readonly reservations = new Map<symbol, readonly string[]>();

  acquire(paths: readonly string[]): PathReservation | undefined {
    const normalized = [...new Set(paths.map(normalizeAbsolutePath))];
    if (normalized.some(candidate => this.isReserved(candidate))) return undefined;

    const id = Symbol("path reservation");
    this.reservations.set(id, normalized);
    let released = false;
    return {
      paths: normalized,
      release: () => {
        if (released) return;
        released = true;
        this.reservations.delete(id);
      },
    };
  }

  isReserved(candidate: string): boolean {
    for (const reserved of this.reservations.values()) {
      if (reserved.some(existing => pathsOverlap(candidate, existing))) return true;
    }
    return false;
  }
}
