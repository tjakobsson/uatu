import type { DocumentMeta, RootGroup } from "../shared/types";
import { setMainSurface } from "./surface";

export type WorkspaceFileReference = { document: DocumentMeta; line?: number };

export function resolveWorkspaceFileReference(raw: string, roots: RootGroup[]): WorkspaceFileReference | null {
  const match = raw.trim().match(/^(.*?)(?::(\d+))?(?::\d+)?$/);
  if (!match) return null;
  let candidate = match[1]!.replaceAll("\\", "/");
  const line = match[2] ? Number(match[2]) : undefined;
  if (!candidate || candidate.includes("\0") || candidate.split("/").includes("..") || (line !== undefined && (!Number.isSafeInteger(line) || line < 1))) return null;

  const matches: DocumentMeta[] = [];
  if (candidate.startsWith("/")) {
    for (const root of roots) {
      const rootPath = root.path.replaceAll("\\", "/").replace(/\/$/, "");
      if (candidate === rootPath || !candidate.startsWith(`${rootPath}/`)) continue;
      const relative = candidate.slice(rootPath.length + 1);
      const document = root.docs.find(item => item.relativePath === relative);
      if (document) matches.push(document);
    }
  } else {
    candidate = candidate.replace(/^\.\//, "");
    for (const root of roots) {
      const document = root.docs.find(item => item.relativePath === candidate);
      if (document) matches.push(document);
    }
  }
  return matches.length === 1 ? { document: matches[0]!, ...(line ? { line } : {}) } : null;
}

export async function navigateWorkspaceFileReference(reference: WorkspaceFileReference): Promise<void> {
  const [{ applyUserRowClick }, { revealPreviewSurface }, { applyViewMode }] = await Promise.all([
    import("../shell/follow"),
    import("../shell/tab-bar"),
    import("../preview/view-mode"),
  ]);
  setMainSurface("preview");
  revealPreviewSurface();
  if (reference.line) applyViewMode("source");
  await applyUserRowClick(reference.document.id);
  if (reference.line) {
    requestAnimationFrame(() => {
      const line = document.querySelector<HTMLElement>(`#preview .uatu-cl[data-ln="${reference.line}"]`);
      line?.scrollIntoView({ block: "center" });
      line?.classList.add("chat-file-line-target");
    });
  }
}
