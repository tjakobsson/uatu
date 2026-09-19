import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { generateVAPIDKeys, type PushSubscription, type VapidKeys } from "./push-sender";
import type { AgentNotification } from "../chat/notifications";

export const NOTIFICATION_CATEGORIES = ["needsAnswer", "completed"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
export type NotificationPreferences = { workspaceIds: string[] } & Record<NotificationCategory, boolean>;
export type NotificationDevice = NotificationPreferences & {
  id: string; user: string; sessionId: string; subscription: PushSubscription;
  /** Per workspace, the moment each enabled category started counting; earlier events are history for this device. */
  since: Record<string, Partial<Record<NotificationCategory, number>>>; createdAt: number;
};
export type NotificationDelivery = {
  key: string; deviceId: string; workspaceId: string; notification?: AgentNotification;
  status: "pending" | "accepted" | "discarded"; createdAt: number; attempts: number; nextAttemptAt: number;
};
export type NotificationData = {
  version: 1; keys: VapidKeys; devices: NotificationDevice[];
  deliveries: NotificationDelivery[]; cursors: Record<string, string>;
};

export class NotificationStore {
  private data: NotificationData | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, "utf8")) as NotificationData;
      if (value.version !== 1 || typeof value.keys?.publicKey !== "string" || typeof value.keys?.privateKey !== "string"
        || !Array.isArray(value.devices) || !Array.isArray(value.deliveries) || !value.cursors) throw new Error("invalid notification state");
      for (const device of value.devices) for (const [ws, since] of Object.entries(device.since ?? {})) {
        // Pre-release enrollments stored one cutoff per workspace.
        if (typeof since === "number") device.since[ws] = { needsAnswer: since, completed: since };
      }
      this.data = value;
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("cannot load hub notification state", { cause: error });
      this.data = { version: 1, keys: generateVAPIDKeys(), devices: [], deliveries: [], cursors: {} };
      await this.mutate(() => {});
    }
  }

  snapshot(): NotificationData {
    if (!this.data) throw new Error("notification store is not loaded");
    return structuredClone(this.data);
  }

  mutate<T>(operation: (data: NotificationData) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const next = this.snapshot();
      const result = operation(next);
      const temp = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        const file = await fs.open(temp, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(next) + "\n"); await file.sync(); } finally { await file.close(); }
        await fs.chmod(temp, 0o600);
        await fs.rename(temp, this.filePath);
        this.data = next;
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      return result;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  async settled(): Promise<void> { await this.chain; }
}
