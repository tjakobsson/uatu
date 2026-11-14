import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Renovate 44.199.2 logs the real extraction at trace level as { config },
// msg="packageFiles" (lib/workers/repository/process/extract-update.ts).
export function checkExtraction(source, log) {
  assert.equal(source.repository, "mattpocock/skills");
  assert.equal(source.ref, "main");
  assert.match(source.revision, /^[a-f0-9]{40}$/);
  const records = log.trim().split("\n").map(line => JSON.parse(line));
  const extractions = records.filter(record => record.msg === "packageFiles");
  assert.equal(extractions.length, 1, "Expected exactly one official extraction record");
  const files = extractions[0].config.regex;
  assert.equal(files?.length, 1, "Expected one custom regex package file");
  assert.equal(files[0].packageFile, "skills-source.json");
  assert.equal(files[0].deps.length, 1, "Expected one skill dependency");
  const dependency = files[0].deps[0];
  assert.equal(dependency.depName, source.repository);
  assert.equal(dependency.packageName, `https://github.com/${source.repository}`);
  assert.equal(dependency.datasource, "git-refs");
  assert.equal(dependency.currentValue, source.ref);
  assert.equal(dependency.currentDigest, source.revision);
  assert.equal(dependency.skipReason, undefined);
  return extractions[0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , sourcePath, logPath] = process.argv;
  assert.ok(sourcePath && logPath, "Usage: renovate-check.mjs <source.json> <extract.ndjson>");
  const extraction = checkExtraction(JSON.parse(readFileSync(sourcePath, "utf8")), readFileSync(logPath, "utf8"));
  console.log(JSON.stringify(extraction, null, 2));
  console.log("Official extraction matches the committed skill ref and digest.");
}
