import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { licenseFile, names, receiptFile, sourceFile } from "./skills";

export const scratch = join(process.env.SKILLS_SCRATCH || join(process.env.HOME!, ".cache/opencode/scratch/uatu-workflow-skills"), "tests");
const owned: string[] = [];
export async function fixture() {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "fixture-"));
  owned.push(root);
  const repo = resolve(import.meta.dir, "..");
  for (const path of [sourceFile, "skills-lock.json", receiptFile, licenseFile, ...names.map(n => `.agents/skills/${n}`)]) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await cp(join(repo, path), join(root, path), { recursive: true });
  }
  for (const client of [".claude", ".opencode"]) {
    await mkdir(join(root, client, "skills"), { recursive: true });
    for (const name of names) await symlink(`../../.agents/skills/${name}`, join(root, client, "skills", name));
  }
  return root;
}
export async function cleanup() {
  for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true });
}
