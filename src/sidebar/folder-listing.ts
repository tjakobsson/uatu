// Lists one level of a Git-ignored folder (node_modules/, build/) on demand,
// like VS Code's Explorer reading a folder when it is expanded. The listing
// itself reaches every client through the document stream; this request only
// reports whether it happened.
import { appUrl } from "../shared/app-url";
import type { FolderListingOutcome } from "./tree-view";

export async function listIgnoredFolder(folder: { rootId: string; relativePath: string }): Promise<FolderListingOutcome> {
  try {
    const response = await fetch(appUrl("/api/index/folder"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rootId: folder.rootId, path: folder.relativePath }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return "listed";
    const body = await response.json().catch(() => null) as { status?: string } | null;
    return response.status === 404 && body?.status === "missing" ? "missing" : "failed";
  } catch {
    return "failed";
  }
}
