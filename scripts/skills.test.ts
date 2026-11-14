import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { check, checkInstallerOutputs, digest, folderHash, json, licenseFile, materialize, names, parseSource, pinnedToolVersion, receiptFile, sourceFile } from "./skills";
import { cleanup, fixture, scratch } from "./skills-fixture";
afterEach(cleanup);
test("clean project installation works without personal globals and matches CLI v1 hashes", async () => {
  const root = await fixture();
  expect((await check(root)).repository).toBe("mattpocock/skills");
  expect(await folderHash(root, ".agents/skills/pr")).toBe((await json(join(root, "skills-lock.json"))).skills.pr.computedHash);
});
test("revision-only update fails offline while regenerated fixture passes", async () => {
  const root = await fixture();
  const source = await json(join(root, sourceFile));
  source.revision = "a".repeat(40);
  await writeFile(join(root, sourceFile), JSON.stringify(source));
  await expect(check(root)).rejects.toThrow("Stale generated");
  const receipt = await json(join(root, receiptFile));
  receipt.revision = source.revision;
  await writeFile(join(root, receiptFile), JSON.stringify(receipt));
  await expect(check(root)).rejects.toThrow("lock");
  const lock = await json(join(root, "skills-lock.json"));
  for (const name of names) lock.skills[name].ref = source.revision;
  await writeFile(join(root, "skills-lock.json"), JSON.stringify(lock));
  await check(root);
});
for (const path of [".agents/skills/pr/SKILL.md", ".agents/skills/pr/CREDITS.md", ".agents/skills/code-review/agents/openai.yaml", licenseFile]) {
  test(`changed managed bytes fail: ${path}`, async () => {
    const root = await fixture();
    await writeFile(join(root, path), "tampered");
    await expect(check(root)).rejects.toThrow();
  });
}
test("missing required attribution fails even if the lock hash is recalculated", async () => {
  const root = await fixture();
  await rm(join(root, ".agents/skills/pr/CREDITS.md"));
  const lock = await json(join(root, "skills-lock.json"));
  lock.skills.pr.computedHash = await folderHash(root, ".agents/skills/pr");
  await writeFile(join(root, "skills-lock.json"), JSON.stringify(lock));
  await expect(check(root)).rejects.toThrow("Missing companion");
});
test("unexpected regular files fail the pinned file inventory", async () => {
  const root = await fixture();
  await writeFile(join(root, ".agents/skills/pr/extra.md"), "extra");
  await expect(check(root)).rejects.toThrow();
});
test("installer output allowlist excludes new skills, commands and root files", async () => {
  const root = await fixture();
  // The source declaration is updater input, not an installer output.
  await rm(join(root, sourceFile));
  await checkInstallerOutputs(root);
  await mkdir(join(root, ".claude/skills/openspec-propose"));
  await expect(checkInstallerOutputs(root)).rejects.toThrow("Unexpected installer output");
});
for (const path of [".agents/skills/pr/CREDITS.md", ".agents/skills/pr", ".claude/skills/pr", ".opencode/skills/pr"]) {
  test(`escaping symlink rejected: ${path}`, async () => {
    const root = await fixture();
    await rm(join(root, path), { recursive: true, force: true });
    await symlink(scratch, join(root, path));
    await expect(check(root)).rejects.toThrow();
  });
}
test("materialization is idempotent and leaves OpenSpec skills/commands untouched", async () => {
  const root = await fixture();
  const generated = await fixture();
  const paths = [".claude/skills/openspec-apply-change/SKILL.md", ".opencode/commands/opsx-apply.md", "openspec/config.yaml"];
  for (const path of paths) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), "owned by OpenSpec\n"); }
  const before = digest(await readFile(join(root, receiptFile)));
  await materialize(root, generated);
  await materialize(root, generated);
  await check(root);
  expect(digest(await readFile(join(root, receiptFile)))).toBe(before);
  for (const path of paths) expect(await readFile(join(root, path), "utf8")).toBe("owned by OpenSpec\n");
});
test("materialization refuses a linked managed ancestor before any write", async () => {
  const root = await fixture();
  const generated = await fixture();
  const before = await readFile(join(root, "skills-lock.json"), "utf8");
  await rm(join(root, ".opencode/skills"), { recursive: true });
  await symlink(scratch, join(root, ".opencode/skills"));
  await expect(materialize(root, generated)).rejects.toThrow("Symlink");
  expect(await readFile(join(root, "skills-lock.json"), "utf8")).toBe(before);
});
test("source allowlist rejects moving refs, repository injection and extra config", () => {
  for (const source of [null, { repository: "evil/skills", ref: "main", revision: "a".repeat(40) }, { repository: "mattpocock/skills", ref: "main", revision: "HEAD" }, { repository: "mattpocock/skills", ref: "main", revision: "a".repeat(40), command: "evil" }]) expect(() => parseSource(source)).toThrow();
});
test("the manifest is the sole CLI-version input and receipt mismatches fail validation", async () => {
  expect(pinnedToolVersion({ devDependencies: { skills: "1.7.4" } })).toBe("1.7.4");
  expect(pinnedToolVersion({ devDependencies: { skills: "1.7.5" } })).toBe("1.7.5");
  for (const version of ["latest", "^1.7.4", "~1.7.4", undefined]) expect(() => pinnedToolVersion({ devDependencies: { skills: version } })).toThrow();
  const root = await fixture();
  const receipt = await json(join(root, receiptFile));
  receipt.cli = "0.0.0";
  await writeFile(join(root, receiptFile), JSON.stringify(receipt));
  await expect(check(root)).rejects.toThrow("Stale generated");
});
