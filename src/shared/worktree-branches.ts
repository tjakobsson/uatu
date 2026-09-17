// Presentation/input rules only. Ref inventory and operations belong to callers.
export function validWorktreeBranch(branch: string): boolean {
  return Boolean(branch) && branch !== "@" && !/^[-/]|[\s\x00-\x1f\x7f~^:?*\\\[]|\.\.|@\{|\/\//.test(branch)
    && !/[/.]$/.test(branch) && branch.split("/").every(part => !part.startsWith(".") && !part.endsWith(".lock"));
}

export function initialWorktreeBase(local: string[], remote: string[]): string {
  if (local.includes("main")) return "local:main";
  const mains = remote.filter(ref => ref.slice(ref.indexOf("/") + 1) === "main");
  return mains.length === 1 ? `remote:${mains[0]}` : "";
}
