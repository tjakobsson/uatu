// The dependency audit gate CI runs on every PR (ci.yml) and every Monday
// (dependency-audit.yml): `bun audit` over the whole installed tree, failing on
// a moderate-or-higher advisory.
//
// ACCEPTED lists the advisories we have decided to carry. Each entry needs a
// reason, and every one so far is an advisory with no patched release in a
// package that only dev tooling pulls in, so it never reaches the shipped
// binary. When a patch lands and the lockfile picks it up, the advisory stops
// being reported and this script fails until its entry is deleted. That way
// an ignore can't outlive the advisory it covers.

type Accepted = { ghsa: string; pkg: string; reason: string };

const ACCEPTED: Accepted[] = [
  {
    ghsa: "GHSA-vfj7-8cjw-p6xm",
    pkg: "braces",
    reason:
      "Unpatched (<=3.0.3 is every release). Only @fission-ai/openspec pulls it in " +
      "(fast-glob > micromatch), a dev CLI that expands our own spec globs.",
  },
  {
    ghsa: "GHSA-ch52-4w7c-c8xp",
    pkg: "http-cache-semantics",
    reason:
      "Unpatched (<=4.2.0 is every release). Only astro pulls it in, at static " +
      "build time for the docs site; nothing serves its cache to users.",
  },
];

type Advisory = { url: string; severity: string };

const json = Bun.spawnSync(["bun", "audit", "--json"], { stdout: "pipe", stderr: "inherit" });
const text = json.stdout.toString().trim();
let report: Record<string, Advisory[]>;
try {
  report = text === "" ? {} : JSON.parse(text);
} catch {
  console.error(`bun audit --json printed something that isn't JSON:\n${text}`);
  process.exit(1);
}

const reported = new Set(
  Object.entries(report).flatMap(([pkg, advisories]) =>
    advisories.map(advisory => `${pkg} ${advisory.url.split("/").pop()}`),
  ),
);
const stale = ACCEPTED.filter(entry => !reported.has(`${entry.pkg} ${entry.ghsa}`));
if (stale.length > 0) {
  for (const entry of stale) {
    console.error(
      `${entry.ghsa} (${entry.pkg}) is accepted in scripts/audit-dependencies.ts ` +
        "but bun audit no longer reports it. Delete the entry.",
    );
  }
  process.exit(1);
}

for (const entry of ACCEPTED) console.log(`accepted ${entry.ghsa} (${entry.pkg}): ${entry.reason}`);

const gate = Bun.spawnSync(
  ["bun", "audit", "--audit-level=moderate", ...ACCEPTED.map(entry => `--ignore=${entry.ghsa}`)],
  { stdout: "inherit", stderr: "inherit" },
);
process.exit(gate.exitCode ?? 1);
