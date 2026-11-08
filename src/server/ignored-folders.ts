// Which parts of a root lie inside folders Git ignores as a whole, and which
// levels of those folders a client has listed. Paths are root-relative POSIX
// paths without a trailing slash. A folder inside the ignored tree is read
// only once listed; until then the watcher neither lists nor walks it.
export class IgnoredFolders {
  private readonly tops = new Set<string>();
  private readonly listed = new Set<string>();

  constructor(tops: Iterable<string> = []) {
    for (const top of tops) this.tops.add(top);
  }

  get topFolders(): readonly string[] { return [...this.tops]; }
  get listedFolders(): readonly string[] { return [...this.listed]; }

  addTop(relative: string): void { this.tops.add(relative); }

  // The ignored folder at or above `relative`, if any.
  topOf(relative: string): string | null {
    for (let current = relative; current; current = parent(current)) {
      if (this.tops.has(current)) return current;
    }
    return null;
  }

  isInside(relative: string): boolean { return this.topOf(relative) !== null; }
  isListed(relative: string): boolean { return this.listed.has(relative); }

  // A directory the watcher must not read: inside the ignored tree, unlisted.
  isUnlistedDirectory(relative: string): boolean {
    return this.isInside(relative) && !this.listed.has(relative);
  }

  // A file whose level nobody has listed: captured only from live writes.
  isWindowed(relativeFile: string): boolean {
    const directory = parent(relativeFile);
    return directory !== "" && this.isInside(directory) && !this.listed.has(directory);
  }

  // A folder entry is published for each ignored folder and for each folder
  // directly inside a listed level. Deeper unlisted folders stay implicit.
  isPublishedFolder(relative: string): boolean {
    return this.tops.has(relative) || this.isInside(relative) && this.listed.has(parent(relative));
  }

  markListed(relative: string): void { this.listed.add(relative); }

  // "" forgets everything (the watched root itself went away).
  forget(relative: string): void {
    const under = (candidate: string) => relative === "" || candidate === relative || candidate.startsWith(`${relative}/`);
    for (const top of [...this.tops]) if (under(top)) this.tops.delete(top);
    for (const level of [...this.listed]) if (under(level)) this.listed.delete(level);
  }
}

function parent(relative: string): string {
  const slash = relative.lastIndexOf("/");
  return slash === -1 ? "" : relative.slice(0, slash);
}
