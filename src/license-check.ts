import { promises as fs } from "node:fs";
import path from "node:path";

const forbiddenLicensePatterns = [
  /\bAGPL\b/i,
  /\bGPL\b/i,
  /\bLGPL\b/i,
  /\bMPL\b/i,
  /\bEPL\b/i,
  /\bCDDL\b/i,
  /\bSSPL\b/i,
  /CC-BY-SA/i,
  /CC-BY-NC/i,
];

const permissiveLicensePatterns = [
  /^MIT$/i,
  /^BSD(?:-\d-Clause)?$/i,
  /^ISC$/i,
  /^Apache-2\.0$/i,
  /^0BSD$/i,
  /^CC0-1\.0$/i,
  /^Unlicense$/i,
  /^Python-2\.0$/i,
];

type LicenseRecord = {
  name: string;
  version: string;
  license: string;
};

type PackageJson = {
  name?: string;
  version?: string;
  license?: string;
  licenses?: Array<string | { type?: string }>;
};

export async function collectInstalledLicenses(rootPath: string): Promise<LicenseRecord[]> {
  const packageFiles = await findPackageJsonFiles(path.join(rootPath, "node_modules"));
  const records = new Map<string, LicenseRecord>();

  for (const packageFile of packageFiles) {
    const packageJson = JSON.parse(await fs.readFile(packageFile, "utf8")) as PackageJson;
    const name = packageJson.name;
    const version = packageJson.version;
    const license = extractLicense(packageJson);

    if (!name || !version || !license) {
      continue;
    }

    records.set(`${name}@${version}`, { name, version, license });
  }

  return Array.from(records.values()).sort((left, right) => {
    if (left.name === right.name) {
      return left.version.localeCompare(right.version);
    }

    return left.name.localeCompare(right.name);
  });
}

export function validateLicenseRecords(records: LicenseRecord[]): LicenseRecord[] {
  return records.filter(record => !isAllowedLicenseExpression(record.license));
}

export function isAllowedLicenseExpression(expression: string): boolean {
  return expression
    .split(/\s+OR\s+/i)
    .map(branch => branch.trim())
    .some(branch => isAllowedLicenseBranch(branch));
}

function isAllowedLicenseBranch(branch: string): boolean {
  return branch
    .split(/\s+AND\s+/i)
    .map(part => normalizeLicenseToken(part))
    .every(part => part.length > 0 && isPermissiveLicenseToken(part));
}

function normalizeLicenseToken(token: string): string {
  return token.replace(/[()]/g, "").trim();
}

function isPermissiveLicenseToken(token: string): boolean {
  if (forbiddenLicensePatterns.some(pattern => pattern.test(token))) {
    return false;
  }

  return permissiveLicensePatterns.some(pattern => pattern.test(token));
}

function extractLicense(packageJson: PackageJson): string | null {
  if (typeof packageJson.license === "string" && packageJson.license.length > 0) {
    return packageJson.license;
  }

  if (Array.isArray(packageJson.licenses) && packageJson.licenses.length > 0) {
    return packageJson.licenses
      .map(entry => (typeof entry === "string" ? entry : entry.type ?? ""))
      .filter(Boolean)
      .join(" OR ");
  }

  return null;
}

async function findPackageJsonFiles(directory: string): Promise<string[]> {
  const results: string[] = [];
  const stack = [directory];

  while (stack.length > 0) {
    const currentDirectory = stack.pop();
    if (!currentDirectory) {
      continue;
    }

    let entries;
    try {
      entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name === ".bin") {
        continue;
      }

      const fullPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name === "package.json") {
        results.push(fullPath);
      }
    }
  }

  return results;
}

async function main() {
  const rootPath = process.cwd();
  const records = await collectInstalledLicenses(rootPath);
  const forbidden = validateLicenseRecords(records);

  if (records.length === 0) {
    throw new Error("no installed packages found to audit");
  }

  if (forbidden.length > 0) {
    const details = forbidden.map(record => `${record.name}@${record.version}: ${record.license}`).join("\n");
    throw new Error(`copyleft licenses detected:\n${details}`);
  }

  console.log(`audited ${records.length} installed packages`);
}

if (import.meta.main) {
  await main();
}
