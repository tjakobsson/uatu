import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { WatchEntry } from "../server/roots";

export class ConversationNotFoundError extends Error {
  constructor() {
    super("conversation not found");
    this.name = "ConversationNotFoundError";
  }
}

export type DirectorySession = {
  id: string;
  directory: string;
};

export async function selectCanonicalChatRoot(entries: WatchEntry[]): Promise<string> {
  const first = entries[0];
  if (!first) throw new Error("chat requires a watch root");
  const candidate = first.kind === "dir" ? first.absolutePath : first.parentDir;
  const canonical = await canonicalPath(candidate);
  const info = await stat(canonical.path).catch(() => null);
  if (!canonical.exists || !info?.isDirectory()) {
    throw new Error("chat root is not an available directory");
  }
  return canonical.path;
}

export async function isSessionInWorkspace(sessionDirectory: string, workspaceDirectory: string): Promise<boolean> {
  const [session, workspace] = await Promise.all([
    canonicalPath(sessionDirectory),
    canonicalPath(workspaceDirectory),
  ]);
  return pathComparisonKey(session.path) === pathComparisonKey(workspace.path);
}

export async function requireWorkspaceSession<T extends DirectorySession>(
  sessionId: string,
  workspaceDirectory: string,
  getSession: (sessionId: string) => Promise<T | null>,
): Promise<T> {
  const session = await getSession(sessionId).catch(() => null);
  if (!session || !await isSessionInWorkspace(session.directory, workspaceDirectory)) {
    throw new ConversationNotFoundError();
  }
  return session;
}

async function canonicalPath(input: string): Promise<{ path: string; exists: boolean }> {
  const absolute = path.resolve(input);
  try {
    return { path: await realpath(absolute), exists: true };
  } catch {
    return { path: path.normalize(absolute), exists: false };
  }
}

function pathComparisonKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
