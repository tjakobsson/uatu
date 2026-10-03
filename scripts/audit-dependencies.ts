// The dependency audit gate CI runs on every PR (ci.yml) and every Monday
// (dependency-audit.yml): `bun audit` over the whole installed tree.
//
// A moderate-or-higher advisory fails the run when its package has a release
// outside the vulnerable range, because then there's something to upgrade to.
// An advisory whose package has no such release yet can't be fixed by
// upgrading, so it's reported as a warning annotation instead of blocking
// every pipeline. There is no ignore list: the check reads the package's
// published versions from the npm registry on every run, so the run starting
// after a patched release is published fails again until we take it.
// Low-severity advisories are printed and never block.

export type Advisory = {
  id: number;
  url: string;
  title: string;
  severity: string;
  vulnerable_versions: string;
};

export type Verdict = "fixable" | "unpatched" | "low";

const BLOCKING_SEVERITIES = new Set(["moderate", "high", "critical"]);

/**
 * True when some stable published version is outside the vulnerable range and
 * newer than the oldest vulnerable one. That's an upgrade target. Versions
 * older than every vulnerable release, from before the bug existed, don't count.
 *
 * Throws when no published version is in the vulnerable range at all. bun
 * audit reported one installed, so the version list contradicts the audit,
 * and neither verdict would be true.
 */
export function hasPatchedRelease(vulnerableRange: string, published: string[]): boolean {
  const vulnerable = published.filter(version => Bun.semver.satisfies(version, vulnerableRange));
  if (vulnerable.length === 0) {
    throw new Error(
      `none of its ${published.length} published versions is in the vulnerable range ${vulnerableRange}, ` +
        "so there's nothing to compare a fix against",
    );
  }
  const oldestVulnerable = vulnerable.reduce((a, b) => (Bun.semver.order(a, b) <= 0 ? a : b));
  return published.some(
    version =>
      !version.includes("-") &&
      !Bun.semver.satisfies(version, vulnerableRange) &&
      Bun.semver.order(version, oldestVulnerable) > 0,
  );
}

export function classify(advisory: Advisory, published: string[]): Verdict {
  if (!BLOCKING_SEVERITIES.has(advisory.severity)) return "low";
  return hasPatchedRelease(advisory.vulnerable_versions, published) ? "fixable" : "unpatched";
}

/**
 * Reads `bun audit --json`. A clean tree prints `{}` and exits 0; advisories
 * print an object of them and exit 1. Anything else, including the empty
 * stdout and exit 1 of a failed advisory request, means no audit happened.
 */
export function parseAuditOutput(stdout: string, exitCode: number | null): Record<string, Advisory[]> | string {
  const text = stdout.trim();
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    return `bun audit --json exited ${exitCode} without a JSON report${text === "" ? "" : `:\n${text}`}`;
  }
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    return `bun audit --json printed something other than a report:\n${text}`;
  }
  const entries = Object.values(report);
  if (!entries.every(Array.isArray)) return `bun audit --json printed a report of an unexpected shape:\n${text}`;
  if (exitCode !== 0 && entries.length === 0) return `bun audit --json exited ${exitCode} with an empty report`;
  return report as Record<string, Advisory[]>;
}

/**
 * Classifies one package's advisories, asking for its published versions only
 * when one of them could block. Low advisories never block, so a package that
 * has only those can't fail the gate through a failed registry lookup.
 */
export async function classifyPackage(
  advisories: Advisory[],
  lookupVersions: () => Promise<string[]>,
): Promise<Verdict[]> {
  const published = advisories.some(advisory => BLOCKING_SEVERITIES.has(advisory.severity))
    ? await lookupVersions()
    : [];
  return advisories.map(advisory => classify(advisory, published));
}

async function publishedVersions(pkg: string): Promise<string[]> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  if (!response.ok) throw new Error(`npm registry answered ${response.status} for ${pkg}`);
  const body = (await response.json()) as { versions?: Record<string, unknown> };
  return Object.keys(body.versions ?? {});
}

function ghsaOf(advisory: Advisory): string {
  return advisory.url.split("/").pop() ?? String(advisory.id);
}

async function main(): Promise<number> {
  const audit = Bun.spawnSync(["bun", "audit", "--json"], { stdout: "pipe", stderr: "inherit" });
  const report = parseAuditOutput(audit.stdout.toString(), audit.exitCode);
  if (typeof report === "string") {
    console.error(report);
    return 1;
  }

  const annotate = process.env.GITHUB_ACTIONS === "true";
  let fixable = 0;
  let unpatched = 0;
  for (const [pkg, advisories] of Object.entries(report).sort(([a], [b]) => a.localeCompare(b))) {
    let verdicts: Verdict[];
    try {
      verdicts = await classifyPackage(advisories, () => publishedVersions(pkg));
    } catch (error) {
      // Fail closed: without a usable version list we can't tell a fixable
      // advisory from an unpatched one.
      console.error(`Couldn't classify ${pkg}'s advisories: ${(error as Error).message}`);
      return 1;
    }
    const why = Bun.spawnSync(["bun", "why", pkg], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
    for (const [index, advisory] of advisories.entries()) {
      const verdict = verdicts[index];
      const line = `${pkg} ${advisory.vulnerable_versions} (${advisory.severity}): ${advisory.title} ${advisory.url}`;
      if (verdict === "fixable") {
        fixable++;
        console.error(`FAIL ${line}\n  A release outside the vulnerable range exists; upgrade to it.`);
        if (annotate) console.log(`::error title=Fixable advisory ${ghsaOf(advisory)} (${pkg})::${line}`);
      } else if (verdict === "unpatched") {
        unpatched++;
        console.warn(`WARN ${line}\n  No release outside the vulnerable range yet; this fails once one ships.`);
        if (annotate) console.log(`::warning title=Unpatched advisory ${ghsaOf(advisory)} (${pkg})::${line}`);
      } else {
        console.log(`info ${line}`);
      }
      if (verdict !== "low" && why !== "") console.log(why.replace(/^/gm, "  "));
    }
  }

  if (fixable > 0) {
    console.error(`\n${fixable} advisory(ies) with a patched release: failing. ${unpatched} unpatched (warnings).`);
    return 1;
  }
  console.log(
    unpatched > 0
      ? `\nNo fixable advisories. ${unpatched} unpatched advisory(ies) reported as warnings.`
      : "\nNo moderate-or-higher advisories.",
  );
  return 0;
}

if (import.meta.main) process.exit(await main());
