import type { DocumentMeta, RootGroup } from "../shared/types";

export type WorkspaceFileReference = { document: DocumentMeta; line?: number };

export function resolveWorkspaceFileReference(raw: string, roots: RootGroup[]): WorkspaceFileReference | null {
  const match = raw.trim().match(/^(.*?)(?::(\d+))?(?::\d+)?$/);
  if (!match) return null;
  let candidate = match[1]!.replaceAll("\\", "/");
  const line = match[2] ? Number(match[2]) : undefined;
  if (!candidate || candidate.includes("\0") || candidate.split("/").includes("..") || (line !== undefined && (!Number.isSafeInteger(line) || line < 1))) return null;

  const matches: DocumentMeta[] = [];
  // Absolute also covers Windows drive-qualified paths (C:/workspace/…),
  // which the backslash normalization above produces — a drive path dropped
  // into the relative lookup can never equal a relativePath and goes inert.
  const absolute = candidate.startsWith("/") || /^[A-Za-z]:\//.test(candidate);
  if (absolute) {
    for (const root of roots) {
      const rootPath = root.path.replaceAll("\\", "/").replace(/\/$/, "");
      if (candidate === rootPath || !candidate.startsWith(`${rootPath}/`)) continue;
      const relative = candidate.slice(rootPath.length + 1);
      const document = root.docs.find(item => item.relativePath === relative);
      if (document) matches.push(document);
    }
    // Symlinked roots (and macOS's /tmp → /private/tmp) make the provider
    // report canonical paths while root.path keeps the presented form, so the
    // prefix comparison above never matches. Fall back to the unique document
    // whose full relative path terminates the reference on a real path
    // boundary — ambiguity (across roots or within one) stays inert.
    if (matches.length === 0) {
      for (const root of roots) {
        for (const document of root.docs) {
          if (candidate.endsWith(`/${document.relativePath}`)) matches.push(document);
        }
      }
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
  // Desktop needs no surface change — Preview is co-visible beside the chat
  // panel, so navigation happens in place while the conversation stays put.
  // Touch presents one surface at a time, so there the Preview tab comes
  // forward (revealPreviewSurface is a desktop no-op).
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
