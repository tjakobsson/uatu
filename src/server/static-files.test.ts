import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAssetRoots, resolveWatchRoots } from "./roots";
import { resolveStaticFileRequest, staticFileResponse } from "./static-files";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("asset root helpers", () => {
  test("output folders are served without configuration while explicit exclusions, built-ins and containment hold", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-static-output-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "uatu-static-output-outside-"));
    tempDirectories.push(root, outside);
    await mkdir(path.join(root, "build/renders/private"), { recursive: true });
    await mkdir(path.join(root, "build/objects"));
    await writeFile(path.join(root, ".gitignore"), "/build*/\n");
    for (const name of ["build/renders/public.txt", "build/renders/private/no.txt", "build/renders/.env", "build/objects/main.o", "build/renders/.DS_Store"]) await writeFile(path.join(root, name), "bytes");
    await writeFile(path.join(outside, "outside.txt"), "outside");
    await symlink(outside, path.join(root, "build/renders/link"));
    const entries = [{ kind: "dir" as const, absolutePath: root }];
    for (const name of ["build/renders/public.txt", "build/renders/.env", "build/objects/main.o", "build/renders/private/no.txt"]) expect((await resolveStaticFileRequest(`/${name}`, entries)).status).toBe("found");
    for (const name of ["build/renders/.DS_Store", "build/renders/link/outside.txt"]) expect((await resolveStaticFileRequest(`/${name}`, entries)).status).toBe("not-found");
    await writeFile(path.join(root, ".uatu.json"), JSON.stringify({ ignore: { exclude: ["build/renders/private/**"] } }));
    expect((await resolveStaticFileRequest("/build/renders/private/no.txt", entries)).status).toBe("not-found");
    expect((await resolveStaticFileRequest("/build/renders/public.txt", entries)).status).toBe("found");
  });
  test("getAssetRoots returns dir paths for dirs and parent dirs for files", () => {
    const roots = getAssetRoots([
      { kind: "dir", absolutePath: "/repo/docs" },
      { kind: "file", absolutePath: "/repo/README.md", parentDir: "/repo" },
    ]);
    expect(roots).toEqual(["/repo/docs", "/repo"]);
  });

  test("resolveStaticFileRequest rejects path traversal via double-dot", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-static-traversal-"));
    tempDirectories.push(tempDirectory);

    const resolved = await resolveStaticFileRequest(
      "/../etc/passwd",
      [{ kind: "dir", absolutePath: tempDirectory }],
    );

    expect(resolved).toEqual({ status: "not-found" });
  });

  test("resolveStaticFileRequest rejects path traversal via percent-encoded dots", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-static-encoded-traversal-"));
    tempDirectories.push(tempDirectory);

    const resolved = await resolveStaticFileRequest(
      "/%2e%2e/secret.txt",
      [{ kind: "dir", absolutePath: tempDirectory }],
    );

    expect(resolved).toEqual({ status: "not-found" });
  });

  test("Git-ignore visibility does not deny static delivery, explicit Uatu exclusions do", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-static-ignore-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, ".gitignore"), "secret.txt\n");
    await writeFile(path.join(tempDirectory, "secret.txt"), "hidden\n");

    const resolved = await resolveStaticFileRequest(
      "/secret.txt",
      [{ kind: "dir", absolutePath: tempDirectory }],
      { respectGitignore: true },
    );

    expect(resolved).toEqual({ status: "found", filePath: await realpath(path.join(tempDirectory, "secret.txt")) });
    await writeFile(path.join(tempDirectory, ".uatu.json"), JSON.stringify({ ignore: { exclude: ["secret.txt"] } }));
    expect(await resolveStaticFileRequest("/secret.txt", [{ kind: "dir", absolutePath: tempDirectory }])).toEqual({ status: "not-found" });
  });

  test("single-file static access retains launch scope and skips adjacent project configuration", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-static-file-ignore-"));
    tempDirectories.push(tempDirectory);
    const readmePath = path.join(tempDirectory, "README.md");
    await writeFile(readmePath, "# Readme\n");
    await writeFile(path.join(tempDirectory, ".uatu.json"), JSON.stringify({ ignore: { exclude: ["README.md"] } }));
    await writeFile(path.join(tempDirectory, ".gitignore"), "secret.txt\n");
    await writeFile(path.join(tempDirectory, "secret.txt"), "hidden\n");

    const resolved = await resolveStaticFileRequest(
      "/secret.txt",
      [{ kind: "file", absolutePath: readmePath, parentDir: tempDirectory }],
      { respectGitignore: true },
    );

    expect(resolved).toEqual({ status: "not-found" });
    expect((await resolveStaticFileRequest("/README.md", [{ kind: "file", absolutePath: readmePath, parentDir: tempDirectory }])).status).toBe("found");
  });

  test("resolveStaticFileRequest respects --no-gitignore", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-static-no-gitignore-"));
    tempDirectories.push(tempDirectory);
    const secretPath = path.join(tempDirectory, "hidden.txt");
    await writeFile(path.join(tempDirectory, ".gitignore"), "hidden.txt\n");
    await writeFile(secretPath, "visible when gitignore disabled\n");

    const resolved = await resolveStaticFileRequest(
      "/hidden.txt",
      [{ kind: "dir", absolutePath: tempDirectory }],
      { respectGitignore: false },
    );

    expect(resolved).toEqual({ status: "found", filePath: await realpath(secretPath) });
  });

  test("resolveStaticFileRequest rejects symlink escapes", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-static-symlink-"));
    const outsideDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-static-outside-"));
    tempDirectories.push(tempDirectory, outsideDirectory);
    const outsideFile = path.join(outsideDirectory, "outside.txt");
    await writeFile(outsideFile, "outside\n");
    await symlink(outsideFile, path.join(tempDirectory, "linked.txt"));

    const resolved = await resolveStaticFileRequest(
      "/linked.txt",
      [{ kind: "dir", absolutePath: tempDirectory }],
    );

    expect(resolved).toEqual({ status: "not-found" });
  });

  test("resolveStaticFileRequest rejects malformed URL encoding", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-static-bad-url-"));
    tempDirectories.push(tempDirectory);

    const resolved = await resolveStaticFileRequest(
      "/%GG",
      [{ kind: "dir", absolutePath: tempDirectory }],
    );

    expect(resolved).toEqual({ status: "not-found" });
  });

  test("resolveStaticFileRequest serves secret-like files unless explicitly excluded", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-static-secret-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, ".env.local"), "TOKEN=secret\n");
    const entries = [{ kind: "dir" as const, absolutePath: tempDirectory }];

    expect((await resolveStaticFileRequest("/.env.local", entries)).status).toBe("found");
    await writeFile(path.join(tempDirectory, ".uatu.json"), JSON.stringify({ ignore: { exclude: [".env*"] } }));
    expect(await resolveStaticFileRequest("/.env.local", entries)).toEqual({ status: "not-found" });
  });
});
