// The only built-in exclusions: VS Code's `files.exclude` defaults, checked
// against microsoft/vscode 1.145.2
// (src/vs/workbench/contrib/files/browser/files.contribution.ts). Version
// control metadata and OS litter, hidden at every depth. Everything else is
// decided by Git-ignore visibility or an explicit `.uatu.json ignore.exclude`.
// The VCS directories also keep the watcher out of Git internals.
const deniedNames = new Set([".git", ".svn", ".hg", ".jj", ".ds_store", "thumbs.db"]);

export function shouldDenyPath(relativePath: string): boolean {
  return relativePath.split("/").some(name => deniedNames.has(name.toLowerCase()));
}
