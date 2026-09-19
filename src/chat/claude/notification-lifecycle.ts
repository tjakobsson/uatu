import { boundedSet } from "../../shared/bounded-map";
import type { NormalizedProviderEvent } from "../provider";

type Turn = NonNullable<NormalizedProviderEvent["notificationTurns"]>[number];

// One instance per SDK query. Accepted prompts queue in execution order; a
// background follow-up can own the current result ahead of queued user work.
export class ClaudeNotificationLifecycle {
  private readonly prompts: Array<{ id: string; createdAt: number }> = [];
  private followup: { id: string; createdAt: number } | null = null;
  private readonly results = new Map<string, true>();

  accept(id: string, createdAt: number): Turn[] {
    if (this.prompts.some(prompt => prompt.id === id)) return [];
    this.prompts.push({ id, createdAt });
    return this.prompts.length === 1 && !this.followup ? [{ sourceId: id, phase: "started", createdAt }] : [];
  }

  beginFollowup(id: string, createdAt: number): Turn[] {
    if (this.followup) return [];
    this.followup = { id, createdAt };
    return [{ sourceId: id, phase: "started", createdAt }];
  }

  hasResult(id: string): boolean { return this.results.has(id); }

  finish(resultId: string, phase: Exclude<Turn["phase"], "started">, createdAt: number): Turn[] {
    if (this.results.has(resultId)) return [];
    boundedSet(this.results, resultId, true, 8192);
    const current = this.followup ?? this.prompts.shift();
    this.followup = null;
    if (!current) return [];
    const turns: Turn[] = [{ sourceId: current.id, phase, createdAt }];
    const next = this.prompts[0];
    if (next) turns.push({ sourceId: next.id, phase: "started", createdAt });
    return turns;
  }
}
