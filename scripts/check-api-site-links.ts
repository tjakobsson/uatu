import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const output = resolve(process.argv[2] ?? "site/dist");

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]));
  return files.flat();
}

const files = await walk(output);
const available = new Set(files.map(file => `/${relative(output, file)}`));
const failures: string[] = [];

function targetFor(href: string): string | undefined {
  if (/^(?:https?:|mailto:|#|data:)/.test(href)) return;
  const clean = href.split(/[?#]/, 1)[0];
  if (clean.startsWith("/") && !clean.startsWith("/uatu/")) return `root-relative URL escapes /uatu/: ${href}`;
  const siteRelative = clean.startsWith("/uatu/") ? clean.slice(5) : clean;
  const path = siteRelative.endsWith("/") ? `${siteRelative}index.html` : siteRelative;
  return available.has(path) || available.has(`${path}/index.html`) ? undefined : `missing target: ${href}`;
}

for (const file of files.filter(file => extname(file) === ".html")) {
  const html = await readFile(file, "utf8");
  for (const match of html.matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
    const failure = targetFor(match[1]);
    if (failure) failures.push(`${relative(output, file)}: ${failure}`);
  }
}

if (failures.length) throw new Error(`Static site link check failed:\n${failures.join("\n")}`);
console.log(`Checked ${files.filter(file => extname(file) === ".html").length} HTML files under /uatu/`);
