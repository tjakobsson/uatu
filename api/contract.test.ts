import { describe, expect, test } from "bun:test";

import { createAjv, openApiOperations, readJson, readYaml, schemaForAjv, validateApi } from "../scripts/validate-api";

type Inventory = { operations: Array<{ operationId: string; method: string; path: string; childPath?: string; transport?: string; runtime: string }> };
type Streaming = { channels: Record<string, unknown>; schemas: Record<string, object> };

describe("API contract structure", () => {
  test("metadata, schemas, and all source examples validate", async () => {
    await validateApi();
  });

  test("OpenAPI operations exactly match the public inventory", async () => {
    const [openapi, inventory] = await Promise.all([
      readYaml<Parameters<typeof openApiOperations>[0]>("api/openapi.yaml"),
      readYaml<Inventory>("api/operations.yaml"),
    ]);
    const actual = openApiOperations(openapi).map(({ method, path, operationId }) => `${operationId} ${method} ${path}`).sort();
    const expected = inventory.operations.map(({ method, path, operationId }) => `${operationId} ${method} ${path}`).sort();
    expect(actual).toEqual(expected);
    expect(new Set(inventory.operations.map(operation => operation.operationId)).size).toBe(inventory.operations.length);
  });

  test("Hub cookie authentication matches the runtime cookie name", async () => {
    const openapi = await readYaml<{ components: { securitySchemes: { hubCookie: { name: string } } } }>("api/openapi.yaml");
    expect(openapi.components.securitySchemes.hubCookie.name).toBe("uatu_hub");
  });

  test("public logout uses the bearer JSON transport", async () => {
    const openapi = await readYaml<{ paths: { "/logout": { post: { security: unknown } } } }>("api/openapi.yaml");
    expect(openapi.paths["/logout"].post.security).toEqual([{ hubBearer: [] }]);
  });

  test("every proxied HTTP operation documents an unreachable child", async () => {
    const [openapi, inventory] = await Promise.all([
      readYaml<{ paths: Record<string, Record<string, { responses?: Record<string, unknown> }>> }>("api/openapi.yaml"),
      readYaml<Inventory>("api/operations.yaml"),
    ]);
    for (const operation of inventory.operations.filter(item => item.childPath && item.transport !== "websocket")) {
      expect(openapi.paths[operation.path]?.[operation.method.toLowerCase()]?.responses?.["502"]).toBeDefined();
    }
  });

  test("metadata revisions agree with OpenAPI and changelog", async () => {
    const [metadata, openapi, changelog] = await Promise.all([
      readJson<{ hubApiRevision: number; workspaceApiRevision: number }>("api/contract.json"),
      readYaml<{ info: { "x-uatu-revisions": { hubApiRevision: number; workspaceApiRevision: number } } }>("api/openapi.yaml"),
      Bun.file(new URL("CHANGELOG.md", new URL("./", import.meta.url))).text(),
    ]);
    expect(openapi.info["x-uatu-revisions"]).toEqual({
      hubApiRevision: metadata.hubApiRevision,
      workspaceApiRevision: metadata.workspaceApiRevision,
    });
    expect(changelog).toContain(`## Hub ${metadata.hubApiRevision} / Workspace ${metadata.workspaceApiRevision}`);
    expect(changelog).toMatch(/Compatibility: (initial|additive|breaking)/);
    expect(changelog).toMatch(/### Migration\n\n\S/);
  });

  test("every exclusion is explicit and uniquely identified", async () => {
    const manifest = await readYaml<{ exclusions: Array<Record<string, unknown>> }>("api/exclusions.yaml");
    expect(manifest.exclusions.length).toBeGreaterThan(0);
    expect(new Set(manifest.exclusions.map(item => item.id)).size).toBe(manifest.exclusions.length);
    for (const item of manifest.exclusions) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.reason).toBe("string");
      expect("path" in item || "pathPattern" in item).toBe(true);
      expect(Array.isArray(item.methods)).toBe(true);
    }
  });
});

describe("streaming protocol is closed", () => {
  test("rejects unknown events, controls, and close codes but accepts binary PTY data", async () => {
    const contract = await readYaml<Streaming & { channels: { terminal: { closeCodes: Array<{ code: number }> } } }>("api/streaming.yaml");
    const ajv = createAjv();
    const compile = (name: string) => ajv.compile(schemaForAjv(contract.schemas[name], contract.schemas));
    expect(compile("ClonePhase")({ phase: "unknown" })).toBe(false);
    expect(compile("SearchStreamItem")({ kind: "error", error: "boom" })).toBe(false);
    expect(compile("TerminalAttachReady")({ type: "ping", cols: 80, rows: 24 })).toBe(false);
    expect(compile("TerminalResize")({ type: "resize", cols: 0, rows: 24 })).toBe(false);
    const cloneEvents = (contract.channels as unknown as { cloneJobEvents: { events: Array<{ name: string }> } }).cloneJobEvents.events;
    expect(cloneEvents.map(event => event.name)).not.toContain("error");
    expect(contract.channels.terminal.closeCodes.map(item => item.code)).not.toContain(4444);
    expect(contract.channels.terminal.closeCodes.map(item => item.code)).toEqual([1000, 1011, 4001, 4404, 4409, 4410]);
    expect(new Uint8Array([0, 255, 10])).toBeInstanceOf(Uint8Array);
  });
});

describe("conversation configuration and rename", () => {
  test("configuration requires a model when a variant is present", async () => {
    const openapi = await readYaml<{ components: { schemas: Record<string, object> } }>("api/openapi.yaml");
    const validate = createAjv().compile(schemaForAjv(openapi.components.schemas.ConversationConfiguration, openapi.components.schemas));
    expect(validate({})).toBe(true);
    expect(validate({ model: { providerId: "anthropic", modelId: "claude" }, variant: "high" })).toBe(true);
    expect(validate({ variant: "high" })).toBe(false);
  });

  test("rename request is closed and documents the UTF-8 byte limit", async () => {
    const openapi = await readYaml<{ components: { schemas: Record<string, object> } }>("api/openapi.yaml");
    const schema = openapi.components.schemas.ConversationRenameRequest as { properties: { title: Record<string, unknown> } };
    const validate = createAjv().compile(schemaForAjv(openapi.components.schemas.ConversationRenameRequest, openapi.components.schemas));
    expect(validate({ requestId: "rename-1", title: "New title" })).toBe(true);
    expect(validate({ requestId: "rename-1", title: "   " })).toBe(false);
    expect(validate({ requestId: "rename-1", title: "New title", extra: true })).toBe(false);
    expect(schema.properties.title["x-uatu-maxUtf8Bytes"]).toBe(200);
  });
});

describe("Hub credential contracts", () => {
  test("a populated Hub state includes workspace credential status and assignment names", async () => {
    const openapi = await readYaml<{ components: { schemas: Record<string, object> } }>("api/openapi.yaml");
    const validate = createAjv().compile(schemaForAjv(openapi.components.schemas.HubState, openapi.components.schemas));
    expect(validate({
      version: "0.5.1 (abcdef0)",
      hubApiRevision: 4,
      workspaceApiRevision: 6,
      workspaces: [{
        id: "uatu",
        path: "/src/uatu",
        backend: "local",
        running: true,
        credentialRestartRequired: true,
        credentialAssignments: {
          authentication: ["Work GitHub"],
          signing: ["Work signing"],
        },
        workspaceApiRevision: 6,
        shells: [{ attached: false, label: "zsh" }],
      }],
    })).toBe(true);
    expect(validate({
      version: "0.5.1 (abcdef0)",
      hubApiRevision: 4,
      workspaceApiRevision: 6,
      workspaces: [{ id: "uatu", path: "/src/uatu", backend: "local", running: true, credentialRestartRequired: false, workspaceApiRevision: 6 }],
    })).toBe(false);
  });

  test("public DTO fixtures are closed and reject secret-bearing fields", async () => {
    const openapi = await readYaml<{ components: { schemas: Record<string, object> } }>("api/openapi.yaml");
    const validate = createAjv().compile(schemaForAjv(openapi.components.schemas.PublicCredential, openapi.components.schemas));
    const base = {
      id: "credential-1",
      name: "Work credential",
      enabled: true,
      createdAt: "2026-08-20T12:00:00.000Z",
      assignments: [],
      readiness: [{ layer: "credential", status: "ready", message: "Credential is available." }],
    };
    const fixtures = [
      { ...base, type: "ssh", capabilities: ["ssh-authentication"], metadata: { publicKey: "ssh-ed25519 AAAA", fingerprint: "SHA256:public" } },
      { ...base, type: "openpgp", capabilities: ["openpgp-signing"], metadata: { publicKey: "-----BEGIN PGP PUBLIC KEY BLOCK-----", fingerprint: "0123456789ABCDEF" } },
      { ...base, type: "token", capabilities: ["https-git"], metadata: { host: "github.com", username: "git" } },
    ];
    for (const fixture of fixtures) expect(validate(fixture)).toBe(true);
    for (const field of ["privateKey", "passphrase", "token", "secret", "agentSocket"]) {
      expect(validate({ ...fixtures[0], [field]: "must-not-ship" })).toBe(false);
      expect(validate({ ...fixtures[0], metadata: { ...fixtures[0]!.metadata, [field]: "must-not-ship" } })).toBe(false);
    }
  });

  test("assignment, tool, and clone-selection fixtures match their closed schemas", async () => {
    const openapi = await readYaml<{ components: { schemas: Record<string, object> } }>("api/openapi.yaml");
    const compile = (name: string) => createAjv().compile(schemaForAjv(openapi.components.schemas[name], openapi.components.schemas));
    expect(compile("CredentialAssignment")({ workspaceId: "uatu", credentialId: "credential-1", role: "authentication", host: "github.com" })).toBe(true);
    expect(compile("PublicCredentialTool")({ tool: "git", path: "/usr/bin/git", version: "git version 2.50.0", results: [], guidance: null })).toBe(true);
    const clone = compile("CreateCloneJobRequest");
    expect(clone({ url: "https://github.com/example/repo.git", dest: "/src" })).toBe(true);
    expect(clone({ url: "https://github.com/example/repo.git", dest: "/src", credentialId: "credential-1", retainAssignment: true })).toBe(true);
    expect(clone({ url: "https://github.com/example/repo.git", dest: "/src", retainAssignment: true })).toBe(false);
    expect(clone({ url: "https://github.com/example/repo.git", dest: "/src", credentialId: "credential-1", extra: true })).toBe(false);
    const paired = compile("AssignWorkspaceCredentialsRequest");
    expect(paired({ authentication: { credentialId: "credential-1", host: "github.com" }, signing: { credentialId: "credential-2" } })).toBe(true);
    expect(paired({})).toBe(false);
    expect(paired({ signing: { credentialId: "credential-2", extra: true } })).toBe(false);
  });

  test("SSH unlock permits empty input without relaxing generated passphrases", async () => {
    const openapi = await readYaml<{ components: { schemas: Record<string, object> } }>("api/openapi.yaml");
    const compile = (name: string) => createAjv().compile(schemaForAjv(openapi.components.schemas[name], openapi.components.schemas));
    expect(compile("UnlockCredentialRequest")({ passphrase: "" })).toBe(true);
    expect(compile("GenerateSshCredentialRequest")({ name: "SSH", capabilities: ["ssh-authentication"], passphrase: "" })).toBe(false);
    expect(compile("GenerateOpenPgpCredentialRequest")({ name: "PGP", userId: "User <u@example.test>", passphrase: "" })).toBe(false);
  });
});

describe("Hub folder mutation contracts", () => {
  test("requests, successes, and stop conflicts are closed", async () => {
    const openapi = await readYaml<{ components: { schemas: Record<string, object> } }>("api/openapi.yaml");
    const compile = (name: string) => createAjv().compile(schemaForAjv(openapi.components.schemas[name], openapi.components.schemas));

    const createRequest = compile("CreateFolderRequest");
    expect(createRequest({ parent: "/src", name: "new-project" })).toBe(true);
    expect(createRequest({ parent: "/src", name: "new-project", extra: true })).toBe(false);
    expect(createRequest({ parent: "/src", name: ".hidden" })).toBe(false);
    expect(createRequest({ parent: "/src", name: "nested/folder" })).toBe(false);

    const renameRequest = compile("RenameFolderRequest");
    expect(renameRequest({ path: "/src/old", name: "new", stop: true })).toBe(true);
    expect(renameRequest({ path: "/src/old", name: "new", stop: true, extra: true })).toBe(false);
    const removeRequest = compile("RemoveFolderRequest");
    expect(removeRequest({ path: "/src/old" })).toBe(true);
    expect(removeRequest({ path: "/src/old", stop: "yes" })).toBe(false);

    expect(compile("CreateFolderResult")({ path: "/src/new" })).toBe(true);
    expect(compile("CreateFolderResult")({ path: "/src/new", extra: true })).toBe(false);
    expect(compile("RenameFolderResult")({ path: "/src/new", workspaceIds: ["old"] })).toBe(true);
    expect(compile("RenameFolderResult")({ path: "/src/new", workspaceIds: [], extra: true })).toBe(false);
    expect(compile("RemoveFolderResult")({ path: "/src/old", workspaceId: "old" })).toBe(true);
    expect(compile("RemoveFolderResult")({ path: "/src/old", removed: true })).toBe(false);

    expect(compile("FolderMutationError")({ error: "destination already exists" })).toBe(true);
    expect(compile("FolderMutationError")({ error: "conflict", needsStop: true })).toBe(false);
    const stopConflict = compile("FolderStopConflict");
    expect(stopConflict({ error: "affected workspace sessions must be stopped", needsStop: true, workspaceIds: ["old"] })).toBe(true);
    expect(stopConflict({ error: "affected workspace sessions must be stopped", needsStop: false, workspaceIds: ["old"] })).toBe(false);
    expect(stopConflict({ error: "affected workspace sessions must be stopped", needsStop: true, workspaceIds: [], extra: true })).toBe(false);
  });

  test("FolderName rejects the invisible names the server rejects", async () => {
    const openapi = await readYaml<{ components: { schemas: Record<string, { pattern: string }> } }>("api/openapi.yaml");
    const folderName = createAjv().compile(schemaForAjv(openapi.components.schemas.FolderName, openapi.components.schemas));
    // The published pattern is also compiled the way a consumer matching
    // UTF-16 code units would — the two modes differ above the BMP, and only
    // the second can see a surrogate pair.
    const utf16 = new RegExp(openapi.components.schemas.FolderName.pattern);

    for (const name of ["new-project", "docs 2", "日本語", "café"]) {
      expect(folderName(name)).toBe(true);
      expect(utf16.test(name)).toBe(true);
    }
    // Every one of these is rejected by the server's folder-name validator:
    // an OpenAPI-valid request must not be able to carry them.
    for (const name of [
      "\u200b", // zero-width space alone: nonempty, renders blank
      "zero\u200bwidth",
      "project\u202etxt", // right-to-left override: displays as a different name
      "\u00adsoft", // soft hyphen
      "\ufeffbom", // byte order mark
      "word\u2060joiner",
      "ayah\u06dd", // Arabic end of ayah
      "\u180emongolian", // Mongolian vowel separator
      "annotation\ufff9", // interlinear annotation anchor
    ]) {
      expect(folderName(name)).toBe(false);
      expect(utf16.test(name)).toBe(false);
    }
    // Format characters above the BMP: enforced by the UTF-16 spelling, which
    // is why the pattern carries the surrogate pairs at all.
    for (const name of ["tag\u{e0020}s", "music\u{1d173}", "\u{110bd}x", "\u{13430}x", "\u{1bca0}x", "\u{e0001}x"]) {
      expect(utf16.test(name)).toBe(false);
    }
  });
});

describe("structured question answers", () => {
  test("requires ordered non-empty answer arrays and documents custom strings", async () => {
    const openapi = await readYaml<{ components: { schemas: Record<string, object> } }>("api/openapi.yaml");
    const schema = openapi.components.schemas.QuestionOutcome as {
      oneOf: Array<{ properties?: { answers?: { description?: string; items?: { minItems?: number } } } }>;
    };
    const answered = schema.oneOf.find(branch => branch.properties?.answers)?.properties?.answers;
    const validate = createAjv().compile(schemaForAjv(openapi.components.schemas.QuestionOutcome, openapi.components.schemas));

    expect(validate({ kind: "answered", answers: [["Option"], ["custom text"]] })).toBe(true);
    expect(validate({ kind: "answered", answers: [[]] })).toBe(false);
    expect(validate({ kind: "answered", answers: [["   "]] })).toBe(false);
    expect(answered?.items?.minItems).toBe(1);
    expect(answered?.description).toContain("same order");
    expect(answered?.description).toContain("custom strings");
  });
});
