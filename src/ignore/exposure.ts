// Mandatory denials apply at every depth, including admitted output subtrees.
// build/dist are resolved separately by the root's narrow include policy.
const deniedNames = new Set([
  "node_modules", "coverage", ".git", ".svn", ".hg", ".ds_store", "thumbs.db",
  ".cache", ".parcel-cache", ".turbo", ".next", ".nuxt", ".vercel", ".output", ".nitro", ".svelte-kit", ".astro",
  ".venv", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", "__pycache__", ".gradle", ".m2",
  ".npm", ".yarn", ".pnpm-store", ".terraform", ".serverless",
]);
const hiddenSuffixes = [".swp", ".tmp", ".temp", "~"];
const secretNames = new Set([
  ".env", ".npmrc", ".pypirc", ".netrc", ".ssh", "credentials.json", "credential.json",
  "service-account.json", "service_account.json", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
]);
const secretSuffixes = [".pem", ".key", ".p12", ".pfx"];

export function shouldDenyPath(relativePath: string): boolean {
  return relativePath.split("/").some(name => {
    const lower = name.toLowerCase();
    return deniedNames.has(lower) || hiddenSuffixes.some(suffix => name.endsWith(suffix))
      || secretNames.has(lower) || lower.startsWith(".env.")
      || lower.endsWith("-credentials.json") || lower.endsWith("_credentials.json")
      || lower.includes("private-key") || lower.includes("private_key")
      || secretSuffixes.some(suffix => lower.endsWith(suffix));
  });
}
