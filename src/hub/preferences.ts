// Hub-wide preferences: small settings that authenticated users adjust from
// the browser, persisted under the Hub state dir. Deliberately separate from
// the daemon config file (browser Settings must not rewrite operator-managed
// config, which may be mounted read-only) and from per-user personal state
// (the Hub has one host filesystem, so the default workspace parent is
// Hub-wide, not personal).
//
// The default workspace parent is a convenience: it seeds create, clone, and
// pathless browse locations. It is NOT a filesystem authorization boundary —
// workspaces register anywhere the existing host-access rules allow.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFERENCES_VERSION = 1 as const;

export class HubPreferencesError extends Error {
  constructor(
    readonly code: "invalid-input" | "internal",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HubPreferencesError";
  }
}

type HubPreferencesData = {
  version: typeof PREFERENCES_VERSION;
  defaultWorkspaceParent?: string;
};

export type DefaultWorkspaceParentState = {
  // The saved canonical path, or null when nothing is configured.
  configured: string | null;
  // Whether the configured path is currently a readable direct directory.
  // Always false when nothing is configured.
  configuredAvailable: boolean;
  // Where pathless browse/create/clone flows should start: the configured
  // parent while it is usable, the daemon user's home otherwise. The saved
  // value is retained for diagnosis even while unavailable.
  effective: string;
};

export class HubPreferencesStore {
  private data: HubPreferencesData = { version: PREFERENCES_VERSION };
  // Same serialization contract as the registry: each mutate → save →
  // rollback-on-failure runs to completion before the next begins.
  private mutationChain: Promise<unknown> = Promise.resolve();
  private saveCounter = 0;

  constructor(
    private readonly filePath: string,
    private readonly homeDirectory: () => string = () => os.homedir(),
  ) {}

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
      // Missing or unreadable file — defaults.
      this.data = { version: PREFERENCES_VERSION };
      return;
    }
    const record = raw as { version?: unknown; defaultWorkspaceParent?: unknown };
    const parent = record?.version === PREFERENCES_VERSION
      && typeof record.defaultWorkspaceParent === "string"
      && path.isAbsolute(record.defaultWorkspaceParent)
      ? record.defaultWorkspaceParent
      : undefined;
    this.data = { version: PREFERENCES_VERSION, ...(parent === undefined ? {} : { defaultWorkspaceParent: parent }) };
  }

  // Owner-only atomic write: preferences are not secret, but the file lives
  // in the 0700 state root and mode 0600 keeps every Hub state file uniform.
  private async save(): Promise<void> {
    const temp = `${this.filePath}.${process.pid}.${this.saveCounter += 1}.tmp`;
    let created = false;
    try {
      const handle = await fs.open(temp, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(`${JSON.stringify(this.data, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, this.filePath);
      created = false;
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      if (created) await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  configuredDefaultWorkspaceParent(): string | null {
    return this.data.defaultWorkspaceParent ?? null;
  }

  // Validates and saves a new default parent: an existing direct
  // non-symbolic-link directory, persisted as its canonical path.
  setDefaultWorkspaceParent(requested: unknown): Promise<string> {
    return this.enqueueMutation(async () => {
      if (typeof requested !== "string" || requested.includes("\0") || !path.isAbsolute(requested)) {
        throw new HubPreferencesError("invalid-input", "default workspace parent must be an absolute path");
      }
      let stats;
      try {
        stats = await fs.lstat(path.resolve(requested));
      } catch (error) {
        throw new HubPreferencesError("invalid-input", "default workspace parent was not found", { cause: error });
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new HubPreferencesError("invalid-input", "default workspace parent must be a direct non-symbolic-link directory");
      }
      let canonical: string;
      try {
        canonical = await fs.realpath(path.resolve(requested));
      } catch (error) {
        throw new HubPreferencesError("invalid-input", "default workspace parent cannot be resolved", { cause: error });
      }
      const previous = this.data;
      this.data = { version: PREFERENCES_VERSION, defaultWorkspaceParent: canonical };
      try {
        await this.save();
      } catch (error) {
        this.data = previous;
        throw new HubPreferencesError("internal", "failed to persist Hub preferences", { cause: error });
      }
      return canonical;
    });
  }

  clearDefaultWorkspaceParent(): Promise<void> {
    return this.enqueueMutation(async () => {
      if (this.data.defaultWorkspaceParent === undefined) return;
      const previous = this.data;
      this.data = { version: PREFERENCES_VERSION };
      try {
        await this.save();
      } catch (error) {
        this.data = previous;
        throw new HubPreferencesError("internal", "failed to persist Hub preferences", { cause: error });
      }
    });
  }

  // Configured vs effective: the saved value is never silently dropped when
  // its directory disappears — it stays visible for repair while the
  // effective onboarding default falls back to the daemon user's home.
  async resolveDefaultWorkspaceParent(): Promise<DefaultWorkspaceParentState> {
    const configured = this.configuredDefaultWorkspaceParent();
    if (configured === null) {
      return { configured: null, configuredAvailable: false, effective: this.homeDirectory() };
    }
    const available = await this.isReadableDirectDirectory(configured);
    return {
      configured,
      configuredAvailable: available,
      effective: available ? configured : this.homeDirectory(),
    };
  }

  private async isReadableDirectDirectory(candidate: string): Promise<boolean> {
    try {
      const stats = await fs.lstat(candidate);
      if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
      await fs.access(candidate, fs.constants.R_OK | fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}
