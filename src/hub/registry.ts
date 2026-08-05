// The hub's workspace registry: which folders are known, under which stable
// id each is served, and which session backend runs it. Persisted as JSON in
// the hub state dir so session URLs (/s/<id>/…) survive hub and session
// restarts — an id, once assigned to a folder, never changes.
//
// `backend` exists in the schema from day one so a future container/VM
// backend is an additive value, not a schema migration. Only "local" is
// valid in this version.

import { promises as fs } from "node:fs";
import path from "node:path";

export type WorkspaceBackend = "local";

export type WorkspaceEntry = {
  id: string;
  // Absolute path of the workspace folder on the hub host.
  path: string;
  backend: WorkspaceBackend;
};

export type RegistryData = {
  workspaces: WorkspaceEntry[];
};

// Derives the stable slug for a workspace folder: the folder's basename,
// lowercased, non-url-safe runs collapsed to single hyphens. "uatu" for
// ~/src/uatu. Collisions get a numeric suffix at registration time.
export function workspaceSlug(folderPath: string): string {
  const base = path.basename(folderPath).toLowerCase();
  const slug = base
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "workspace" : slug;
}

export class WorkspaceRegistry {
  private workspaces: WorkspaceEntry[] = [];
  // MUTATIONS are serialized, not merely their writes: each mutate → save →
  // rollback-on-failure runs to completion before the next begins. Anything
  // weaker is unsound — with only writes chained, a concurrent register
  // could snapshot state that a failing sibling then rolls back (the
  // rejected entry resurrects from disk), and a whole-array rollback could
  // clobber a concurrent registration from memory. Each write is atomic
  // (temp file + rename) so a crash mid-write cannot corrupt the registry.
  private mutationChain: Promise<unknown> = Promise.resolve();
  private saveCounter = 0;

  constructor(private readonly filePath: string) {}

  // Enqueues one mutation behind every earlier one; a failed predecessor
  // does not block successors.
  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(operation, operation);
    this.mutationChain = next.catch(() => undefined);
    return next;
  }

  async load(): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch {
      // Missing or unreadable file — first run.
      this.workspaces = [];
      return;
    }
    const workspaces = (raw as { workspaces?: unknown })?.workspaces;
    if (!Array.isArray(workspaces)) {
      this.workspaces = [];
      return;
    }
    this.workspaces = workspaces.filter(
      (entry): entry is WorkspaceEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as WorkspaceEntry).id === "string" &&
        typeof (entry as WorkspaceEntry).path === "string" &&
        (entry as WorkspaceEntry).backend === "local",
    );
  }

  // Persist the current state atomically. Only ever called from inside the
  // mutation chain, so the snapshot cannot observe a half-applied sibling.
  private async save(): Promise<void> {
    const data: RegistryData = { workspaces: [...this.workspaces] };
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    const temp = `${this.filePath}.${process.pid}.${(this.saveCounter += 1)}.tmp`;
    await fs.writeFile(temp, serialized);
    await fs.rename(temp, this.filePath);
  }

  list(): WorkspaceEntry[] {
    return [...this.workspaces];
  }

  byId(id: string): WorkspaceEntry | undefined {
    return this.workspaces.find(entry => entry.id === id);
  }

  byPath(folderPath: string): WorkspaceEntry | undefined {
    return this.workspaces.find(entry => entry.path === folderPath);
  }

  // Registers a folder, returning the existing entry when the folder is
  // already known (its id never changes) or minting a collision-suffixed
  // slug for a new one. Any absolute path is registrable — there is no
  // workspaces root; existence is checked at the API boundary, so an entry
  // whose folder later disappears stays registered (surfacing as a failed
  // start, never a silent forget).
  register(folderPath: string, backend: WorkspaceBackend = "local"): Promise<WorkspaceEntry> {
    return this.enqueueMutation(async () => {
      if (!path.isAbsolute(folderPath)) {
        throw new Error(`workspace path must be absolute: ${folderPath}`);
      }
      const existing = this.byPath(folderPath);
      if (existing) {
        return existing;
      }

      const base = workspaceSlug(folderPath);
      let id = base;
      let suffix = 2;
      while (this.byId(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
      }

      const entry: WorkspaceEntry = { id, path: folderPath, backend };
      this.workspaces.push(entry);
      try {
        await this.save();
      } catch (error) {
        // Persistence failed (full/unwritable state volume): roll the
        // mutation back so memory and disk cannot drift — a retry must
        // re-attempt the save rather than find a phantom in-memory entry.
        this.workspaces = this.workspaces.filter(candidate => candidate !== entry);
        throw error;
      }
      return entry;
    });
  }

  remove(id: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      const previous = this.workspaces;
      this.workspaces = this.workspaces.filter(entry => entry.id !== id);
      if (this.workspaces.length === previous.length) {
        return false;
      }
      try {
        await this.save();
      } catch (error) {
        this.workspaces = previous;
        throw error;
      }
      return true;
    });
  }
}
