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

import { isPathAtOrBelow, normalizeAbsolutePath } from "./path-reservations";

export type WorkspaceBackend = "local";

export type WorkspaceEntry = {
  id: string;
  // Absolute path of the workspace folder on the hub host.
  path: string;
  backend: WorkspaceBackend;
  // Mutable human-facing label. Unlike `id` it may change at any time, may
  // duplicate another workspace's name, and never participates in routing.
  displayName: string;
};

export const WORKSPACE_DISPLAY_NAME_MAX_LENGTH = 64;

// A display name is a trimmed human label of 1-64 visible code points with
// no control characters. Uniqueness is deliberately NOT required — stable
// ids and paths disambiguate.
export function validateWorkspaceDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new Error("workspace display name must be a string");
  const trimmed = value.trim();
  if (trimmed === "") throw new Error("workspace display name must not be empty");
  if (/\p{Cc}/u.test(trimmed)) throw new Error("workspace display name must not contain control characters");
  if ([...trimmed].length > WORKSPACE_DISPLAY_NAME_MAX_LENGTH) {
    throw new Error(`workspace display name must be at most ${WORKSPACE_DISPLAY_NAME_MAX_LENGTH} characters`);
  }
  return trimmed;
}

// Deterministic default for entries registered (or persisted) before display
// names existed: the folder basename, sanitized just enough to satisfy
// validation.
export function defaultWorkspaceDisplayName(folderPath: string): string {
  const base = path.basename(folderPath).replace(/\p{Cc}/gu, "").trim();
  const bounded = [...base].slice(0, WORKSPACE_DISPLAY_NAME_MAX_LENGTH).join("").trim();
  return bounded === "" ? "workspace" : bounded;
}

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
    let migrated = false;
    this.workspaces = workspaces
      .filter(
        (entry): entry is { id: string; path: string; backend: "local"; displayName?: unknown } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as WorkspaceEntry).id === "string" &&
          typeof (entry as WorkspaceEntry).path === "string" &&
          (entry as WorkspaceEntry).backend === "local",
      )
      .map(entry => {
        let displayName: string;
        try {
          displayName = validateWorkspaceDisplayName(entry.displayName);
        } catch {
          // Pre-display-name snapshot (or a hand-mangled one): default from
          // the basename without touching id or path.
          displayName = defaultWorkspaceDisplayName(entry.path);
          migrated = true;
        }
        return { id: entry.id, path: entry.path, backend: "local" as const, displayName };
      });
    if (migrated) {
      // Persist the derived names through the serialized writer so the file
      // reaches the new schema exactly once, atomically.
      await this.enqueueMutation(() => this.save());
    }
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

  atOrBelow(folderPath: string): WorkspaceEntry[] {
    return this.workspaces.filter(entry => isPathAtOrBelow(entry.path, folderPath));
  }

  replacePathPrefix(source: string, destination: string): Promise<WorkspaceEntry[]> {
    return this.enqueueMutation(async () => {
      if (!path.isAbsolute(source) || !path.isAbsolute(destination)) {
        throw new Error("workspace path prefixes must be absolute");
      }
      const normalizedSource = normalizeAbsolutePath(source);
      const normalizedDestination = normalizeAbsolutePath(destination);
      const affectedIds = new Set(this.atOrBelow(normalizedSource).map(entry => entry.id));
      if (affectedIds.size === 0) return [];

      const replacements = new Map<string, WorkspaceEntry>();
      for (const entry of this.workspaces) {
        if (!affectedIds.has(entry.id)) continue;
        const relative = path.relative(normalizedSource, normalizeAbsolutePath(entry.path));
        replacements.set(entry.id, {
          ...entry,
          path: relative === "" ? normalizedDestination : path.join(normalizedDestination, relative),
        });
      }

      const occupied = new Set(
        this.workspaces
          .filter(entry => !affectedIds.has(entry.id))
          .map(entry => normalizeAbsolutePath(entry.path)),
      );
      for (const replacement of replacements.values()) {
        const candidate = normalizeAbsolutePath(replacement.path);
        if (occupied.has(candidate)) {
          throw new Error(`workspace path collision: ${replacement.path}`);
        }
        occupied.add(candidate);
      }

      const previous = this.workspaces;
      this.workspaces = previous.map(entry => replacements.get(entry.id) ?? entry);
      try {
        await this.save();
      } catch (error) {
        this.workspaces = previous;
        throw error;
      }
      return this.workspaces.filter(entry => affectedIds.has(entry.id));
    });
  }

  // Reconciles complete entries recorded by the folder-mutation journal.
  // Existing ids are replaced and missing ids are restored in one snapshot.
  restoreEntries(entries: readonly WorkspaceEntry[]): Promise<WorkspaceEntry[]> {
    return this.enqueueMutation(async () => {
      if (entries.length === 0) return [];
      if (entries.some(entry => !path.isAbsolute(entry.path))) {
        throw new Error("invalid workspace recovery entry");
      }
      const restored = entries.map(entry => ({
        ...entry,
        path: normalizeAbsolutePath(entry.path),
        displayName: validateWorkspaceDisplayName(entry.displayName),
      }));
      if (restored.some(entry => entry.backend !== "local")) {
        throw new Error("invalid workspace recovery entry");
      }
      if (new Set(restored.map(entry => entry.id)).size !== restored.length) {
        throw new Error("duplicate workspace recovery id");
      }
      if (new Set(restored.map(entry => entry.path)).size !== restored.length) {
        throw new Error("duplicate workspace recovery path");
      }

      const restoredIds = new Set(restored.map(entry => entry.id));
      const restoredPaths = new Set(restored.map(entry => entry.path));
      for (const entry of this.workspaces) {
        if (!restoredIds.has(entry.id) && restoredPaths.has(normalizeAbsolutePath(entry.path))) {
          throw new Error(`workspace path collision: ${entry.path}`);
        }
      }

      const byId = new Map(restored.map(entry => [entry.id, entry]));
      const previous = this.workspaces;
      this.workspaces = previous
        .map(entry => byId.get(entry.id) ?? entry)
        .concat(restored.filter(entry => !previous.some(existing => existing.id === entry.id)));
      try {
        await this.save();
      } catch (error) {
        this.workspaces = previous;
        throw error;
      }
      return restored.map(entry => ({ ...entry }));
    });
  }

  // Registers a folder, returning the existing entry when the folder is
  // already known (its id never changes) or minting a collision-suffixed
  // slug for a new one. Any absolute path is registrable — there is no
  // workspaces root; existence is checked at the API boundary, so an entry
  // whose folder later disappears stays registered (surfacing as a failed
  // start, never a silent forget).
  register(folderPath: string, backend: WorkspaceBackend = "local", displayName?: string): Promise<WorkspaceEntry> {
    return this.registerWithStatus(folderPath, backend, displayName).then(result => result.entry);
  }

  registerWithStatus(
    folderPath: string,
    backend: WorkspaceBackend = "local",
    displayName?: string,
  ): Promise<{ entry: WorkspaceEntry; created: boolean }> {
    return this.enqueueMutation(async () => {
      if (!path.isAbsolute(folderPath)) {
        throw new Error(`workspace path must be absolute: ${folderPath}`);
      }
      const validatedName = displayName === undefined
        ? defaultWorkspaceDisplayName(folderPath)
        : validateWorkspaceDisplayName(displayName);
      const existing = this.byPath(folderPath);
      if (existing) {
        return { entry: existing, created: false };
      }

      const base = workspaceSlug(folderPath);
      let id = base;
      let suffix = 2;
      while (this.byId(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
      }

      const entry: WorkspaceEntry = { id, path: folderPath, backend, displayName: validatedName };
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
      return { entry, created: true };
    });
  }

  // Updates only the display name. Deliberately outside session lifecycle and
  // folder-mutation coordination: a rename has no filesystem or process side
  // effect, so it is safe while the workspace is running or stopped.
  updateDisplayName(id: string, displayName: string): Promise<WorkspaceEntry | undefined> {
    return this.enqueueMutation(async () => {
      const validated = validateWorkspaceDisplayName(displayName);
      const index = this.workspaces.findIndex(entry => entry.id === id);
      if (index === -1) return undefined;
      const previous = this.workspaces;
      const current = previous[index]!;
      if (current.displayName === validated) return { ...current };
      this.workspaces = previous.map(entry => (entry.id === id ? { ...entry, displayName: validated } : entry));
      try {
        await this.save();
      } catch (error) {
        this.workspaces = previous;
        throw error;
      }
      return { ...this.workspaces[index]! };
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
