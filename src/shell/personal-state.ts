import { appUrl } from "../shared/app-url";
import type { CompareTarget, ViewMode } from "../shared/types";
import type { FilesPaneFilter } from "./state";

export type PersonalWorkspaceState = {
  version: 1;
  documentPath?: string;
  follow?: boolean;
  previewMode?: ViewMode;
  compareTarget?: CompareTarget;
  filesFilter?: FilesPaneFilter;
  lastPtyId?: string;
};

export type PersonalWorkspaceStatePatch = Partial<{
  documentPath: string | null;
  follow: boolean | null;
  previewMode: ViewMode | null;
  compareTarget: CompareTarget | null;
  filesFilter: FilesPaneFilter | null;
  lastPtyId: string | null;
}>;

let available = false;
let enabled = false;
let pending: PersonalWorkspaceStatePatch = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;
type PersonalStateFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let request: PersonalStateFetch = (...args) => fetch(...args);
let lifecycleInstalled = false;
const flushOnPageHide = (): void => {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  void flushPersonalWorkspaceState();
};

export function parsePersonalWorkspaceState(value: unknown): PersonalWorkspaceState {
  const result: PersonalWorkspaceState = { version: 1 };
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return result;
  if (typeof record.documentPath === "string" && record.documentPath.length > 0) {
    result.documentPath = record.documentPath;
  }
  if (typeof record.follow === "boolean") result.follow = record.follow;
  if (record.previewMode === "rendered" || record.previewMode === "source" || record.previewMode === "diff") {
    result.previewMode = record.previewMode;
  }
  if (record.compareTarget === "base" || record.compareTarget === "last-commit") {
    result.compareTarget = record.compareTarget;
  }
  if (record.filesFilter === "all" || record.filesFilter === "changed") {
    result.filesFilter = record.filesFilter;
  }
  if (typeof record.lastPtyId === "string") result.lastPtyId = record.lastPtyId;
  return result;
}

export async function loadPersonalWorkspaceState(): Promise<PersonalWorkspaceState> {
  try {
    const response = await request(appUrl("/api/personal-state"));
    if (!response.ok) return { version: 1 };
    available = true;
    return parsePersonalWorkspaceState(await response.json());
  } catch {
    return { version: 1 };
  }
}

export function enablePersonalStatePersistence(): void {
  enabled = true;
  if (!lifecycleInstalled && typeof window !== "undefined") {
    window.addEventListener("pagehide", flushOnPageHide);
    lifecycleInstalled = true;
  }
}

export function persistPersonalWorkspaceState(patch: PersonalWorkspaceStatePatch): void {
  if (!available || !enabled) return;
  Object.assign(pending, patch);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPersonalWorkspaceState();
  }, 50);
}

export async function flushPersonalWorkspaceState(): Promise<void> {
  if (!available || Object.keys(pending).length === 0) return;
  const body = pending;
  pending = {};
  try {
    const response = await request(appUrl("/api/personal-state"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
    if (!response.ok) throw new Error("personal state update rejected");
  } catch {
    // Resume state is best-effort; active client state remains authoritative.
  }
}

export function resetPersonalStateForTests(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  pending = {};
  available = false;
  enabled = false;
  if (lifecycleInstalled && typeof window !== "undefined") {
    window.removeEventListener("pagehide", flushOnPageHide);
  }
  lifecycleInstalled = false;
  request = (...args) => fetch(...args);
}

export function setPersonalStateFetchForTests(fetchImpl: PersonalStateFetch): void {
  request = fetchImpl;
}
