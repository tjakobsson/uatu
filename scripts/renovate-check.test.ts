import { expect, test } from "bun:test";
import { checkExtraction } from "./renovate-check.mjs";

const source = { repository: "mattpocock/skills", ref: "main", revision: "a".repeat(40) };
const record = () => ({ msg: "packageFiles", config: { regex: [{ packageFile: "skills-source.json", deps: [{
  depName: source.repository, packageName: `https://github.com/${source.repository}`,
  datasource: "git-refs", currentValue: source.ref, currentDigest: source.revision,
}] }] } });

test("accepts a matching extraction record, not unrelated config log messages", () => {
  const extraction = record();
  const log = [JSON.stringify({ msg: "config", config: {} }), JSON.stringify(extraction)].join("\n");
  expect(checkExtraction(source, log)).toEqual(extraction);
});

test("rejects absent, duplicate, mismatched and skipped extraction evidence", () => {
  for (const mutate of [
    (entry: any) => { entry.config.regex = []; },
    (entry: any) => { entry.config.regex[0].packageFile = "other.json"; },
    (entry: any) => { entry.config.regex[0].deps = []; },
    ...["depName", "packageName", "datasource", "currentValue", "currentDigest", "skipReason"].map(key =>
      (entry: any) => { entry.config.regex[0].deps[0][key] = "wrong"; }),
  ]) {
    const extraction = record();
    mutate(extraction);
    expect(() => checkExtraction(source, JSON.stringify(extraction))).toThrow();
  }
  expect(() => checkExtraction(source, JSON.stringify({ msg: "config" }))).toThrow();
  expect(() => checkExtraction(source, [record(), record()].map(entry => JSON.stringify(entry)).join("\n"))).toThrow();
});
