// Account-level policy, deliberately independent of workspace/device and
// operator-managed preferences. Only an absent file/record has default ON.
import { promises as fs } from "node:fs";
import { constants } from "node:fs";

export type PersonalChatPreferences = {
  version: 1;
  revision: number;
  autoBackgroundOnSteer: boolean;
};

export type PersonalChatPreferencesUpdate = {
  version: 1;
  expectedRevision: number;
  autoBackgroundOnSteer: boolean;
};

export class PersonalChatPreferencesError extends Error {
  constructor(
    readonly code: "invalid-input" | "unavailable" | "conflict",
    message: string,
    readonly current?: PersonalChatPreferences,
  ) {
    super(message);
    this.name = "PersonalChatPreferencesError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parsePersonalChatPreferencesUpdate(value: unknown): PersonalChatPreferencesUpdate {
  if (!object(value) || Object.keys(value).some(key => !["version", "expectedRevision", "autoBackgroundOnSteer"].includes(key))
    || value.version !== 1 || !Number.isSafeInteger(value.expectedRevision)
    || (value.expectedRevision as number) < 0 || (value.expectedRevision as number) >= Number.MAX_SAFE_INTEGER
    || typeof value.autoBackgroundOnSteer !== "boolean") {
    throw new PersonalChatPreferencesError("invalid-input", "invalid personal chat preference update");
  }
  return value as PersonalChatPreferencesUpdate;
}

export class PersonalChatPreferencesStore {
  private records = new Map<string, PersonalChatPreferences>();
  private available = false;
  private mutationChain: Promise<unknown> = Promise.resolve();
  private saveCounter = 0;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    this.available = false;
    try {
      // Refuse links and non-private state; opening before reading avoids
      // following a replaced path. The state root is already Hub-leased.
      const handle = await fs.open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let text: string;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1
          || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("unsafe personal state");
        text = await handle.readFile("utf8");
      } finally { await handle.close(); }
      const data: unknown = JSON.parse(text);
      if (!object(data) || data.version !== 1 || !object(data.records)
        || Object.keys(data).some(key => !["version", "records"].includes(key))) throw new Error("invalid persisted format");
      const records = new Map<string, PersonalChatPreferences>();
      for (const [user, state] of Object.entries(data.records)) {
        if (!object(state) || state.version !== 1 || !Number.isSafeInteger(state.revision)
          || (state.revision as number) < 0 || typeof state.autoBackgroundOnSteer !== "boolean"
          || Object.keys(state).some(key => !["version", "revision", "autoBackgroundOnSteer"].includes(key))) throw new Error("invalid persisted record");
        records.set(user, state as PersonalChatPreferences);
      }
      this.records = records;
      this.available = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.records = new Map();
        this.available = true;
      }
    }
  }

  get(user: string): PersonalChatPreferences {
    if (!this.available) throw new PersonalChatPreferencesError("unavailable", "personal chat preferences are unavailable");
    return { ...(this.records.get(user) ?? { version: 1, revision: 0, autoBackgroundOnSteer: true }) };
  }

  update(user: string, value: unknown): Promise<PersonalChatPreferences> {
    const operation = this.mutationChain.then(async () => {
      const input = parsePersonalChatPreferencesUpdate(value);
      const current = this.get(user);
      if (input.expectedRevision !== current.revision) {
        throw new PersonalChatPreferencesError("conflict", "personal chat preferences changed on another device", current);
      }
      const next: PersonalChatPreferences = { version: 1, revision: current.revision + 1, autoBackgroundOnSteer: input.autoBackgroundOnSteer };
      const records = new Map(this.records).set(user, next);
      const temp = `${this.filePath}.${process.pid}.${++this.saveCounter}.tmp`;
      let created = false;
      try {
        const handle = await fs.open(temp, "wx", 0o600);
        created = true;
        try {
          await handle.writeFile(`${JSON.stringify({ version: 1, records: Object.fromEntries(records) })}\n`, "utf8");
          await handle.chmod(0o600);
          await handle.sync();
        } finally { await handle.close(); }
        await fs.rename(temp, this.filePath);
        created = false;
      } catch {
        if (created) await fs.rm(temp, { force: true }).catch(() => undefined);
        throw new PersonalChatPreferencesError("unavailable", "failed to save personal chat preferences");
      }
      // Rename is the commit point: reads never observe an uncommitted save.
      this.records = records;
      return { ...next };
    });
    this.mutationChain = operation.catch(() => undefined);
    return operation;
  }
}
