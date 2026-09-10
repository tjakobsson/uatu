import type { BranchState, WorkspaceView } from "./backend";
import type { PublicCredentialDto } from "../credential-types";

export function branchLabel(branch: BranchState): string {
  switch (branch.kind) {
    case "named": return branch.name;
    case "unborn": return `${branch.name} · no commits`;
    case "detached": return `Detached · ${branch.commit}`;
    case "non-git": return "Not a Git repository";
    case "loading": return "Loading branch…";
    case "unavailable": return `Branch unavailable: ${branch.message}`;
  }
}

/** Assignment facts only: neither presence nor a catalog name establishes readiness. */
export function workspaceAssignmentLabels(assignments: WorkspaceView["assignments"], catalog: PublicCredentialDto[] | "loading" | "unavailable"): string[] {
  const seen = new Set<string>();
  return assignments.flatMap(a => {
    const key = JSON.stringify([a.role, a.role === "authentication" ? a.host : null]);
    if (seen.has(key)) return [];
    seen.add(key);
    const name = Array.isArray(catalog) ? catalog.find(c => c.id === a.credentialId)?.name ?? `Missing credential (${a.credentialId})` : `${catalog === "loading" ? "Loading credential name" : "Credential name unavailable"} (${a.credentialId})`;
    return [`${a.role === "authentication" ? "AUTH" : "SIGNING"}: ${name}${a.role === "authentication" ? ` · ${a.host}` : ""}`];
  });
}
