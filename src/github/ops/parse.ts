// Soft parsing for GitHub answers, in the style of src/chat/validation.ts (no
// schema dependency). Each adapter reads the fields it pinned; what it can't
// read becomes a default plus a note, never a throw, except for the identity
// fields a view can't exist without (`required`).
//
// - Unknown enum values become "other" (GitHub adds values often).
// - Unknown union members (`__typename`) are skipped and counted.

import { GitHubFailure } from "../classify";

export class ParseNotes {
  // Free-form notes for the child log: `enum PullRequestState=QUEUED`.
  readonly notes: string[] = [];
  skippedUnknown = 0;
  note(text: string): void {
    if (this.notes.length < 50) this.notes.push(text);
  }
}

export type JsonObject = Record<string, unknown>;

export function obj(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// A connection's nodes, dropping nulls (GitHub nulls a node it can't show).
export function nodes(connection: unknown): JsonObject[] {
  return arr(obj(connection)?.nodes).flatMap(node => {
    const value = obj(node);
    return value ? [value] : [];
  });
}

export function totalCount(connection: unknown): number {
  const value = obj(connection)?.totalCount;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function int(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

export function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

// GitHub's deleted-account placeholder, as github.com shows it.
export const GHOST = "ghost";

export function login(actor: unknown): string {
  return str(obj(actor)?.login, GHOST) || GHOST;
}

export function enumValue<T extends string>(value: unknown, allowed: readonly T[], notes: ParseNotes, what: string): T | "other" {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  notes.note(`enum ${what}=${typeof value === "string" ? value : typeof value}`);
  return "other";
}

export function required<T>(value: T | null | undefined, what: string, operation: string): T {
  if (value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))) {
    throw new GitHubFailure("unavailable", `GitHub's answer had no ${what}.`, { operation });
  }
  return value;
}
