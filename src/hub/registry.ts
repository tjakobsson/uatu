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

  constructor(private readonly filePath: string) {}

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

  private async save(): Promise<void> {
    const data: RegistryData = { workspaces: this.workspaces };
    await fs.writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
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
  // slug for a new one.
  async register(folderPath: string, backend: WorkspaceBackend = "local"): Promise<WorkspaceEntry> {
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
    await this.save();
    return entry;
  }

  // Drops every entry whose folder is not a DIRECT child of the workspaces
  // root, returning what was removed. The hub calls this at startup so the
  // registry is confined to the configured root — entries from an earlier
  // root (or an older hub version that accepted arbitrary paths) disappear
  // from the dashboard instead of lingering as unreachable ghosts. Only the
  // registration is dropped; folders on disk are never touched.
  async pruneOutsideRoot(workspacesDir: string): Promise<WorkspaceEntry[]> {
    const root = path.resolve(workspacesDir);
    const removed = this.workspaces.filter(entry => path.dirname(path.resolve(entry.path)) !== root);
    if (removed.length === 0) {
      return [];
    }
    this.workspaces = this.workspaces.filter(entry => !removed.includes(entry));
    await this.save();
    return removed;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.workspaces.length;
    this.workspaces = this.workspaces.filter(entry => entry.id !== id);
    if (this.workspaces.length === before) {
      return false;
    }
    await this.save();
    return true;
  }
}
