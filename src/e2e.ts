import { promises as fs } from "node:fs";
import path from "node:path";

export const E2E_PORT = Number.parseInt(process.env.UATU_E2E_PORT ?? "4173", 10);
export const E2E_FIXTURE_ROOT = path.resolve(process.cwd(), "testdata", "watch-docs");
export const E2E_WORKSPACE_ROOT = path.resolve(process.cwd(), ".e2e", "watch-docs");

export async function resetE2EWorkspace(): Promise<void> {
  await fs.mkdir(E2E_WORKSPACE_ROOT, { recursive: true });
  await emptyDirectory(E2E_WORKSPACE_ROOT);
  await copyDirectoryContents(E2E_FIXTURE_ROOT, E2E_WORKSPACE_ROOT);
}

export function workspacePath(...parts: string[]): string {
  return path.join(E2E_WORKSPACE_ROOT, ...parts);
}

async function emptyDirectory(directoryPath: string): Promise<void> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true }).catch(() => []);

  await Promise.all(
    entries.map(entry => fs.rm(path.join(directoryPath, entry.name), { recursive: true, force: true })),
  );
}

async function copyDirectoryContents(sourceDirectory: string, destinationDirectory: string): Promise<void> {
  const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const destinationPath = path.join(destinationDirectory, entry.name);

    if (entry.isDirectory()) {
      await fs.mkdir(destinationPath, { recursive: true });
      await copyDirectoryContents(sourcePath, destinationPath);
      continue;
    }

    await fs.copyFile(sourcePath, destinationPath);
  }
}
