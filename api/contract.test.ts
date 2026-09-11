import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import { createAjv, openApiOperations, readJson, readYaml, schemaForAjv, validateApi } from "../scripts/validate-api";
import { isVisibleFolderName } from "../src/hub/folder-manager";
import {
  formatLiveEnvelope,
  formatLiveHello,
  LIVE_ENVELOPE_EVENT,
  LIVE_HELLO_EVENT,
  LIVE_KEEPALIVE_FRAME,
  LIVE_KEEPALIVE_MS,
  LIVE_MAX_CURSOR_BYTES,
  LIVE_MAX_KEY_BYTES,
  LIVE_MAX_SUBSCRIPTIONS,
  LIVE_MAX_WORKSPACE_ID_BYTES,
  LIVE_OPEN_FRAME,
  LIVE_STREAM_PATH,
  LIVE_TOPICS,
  type LiveEnvelope,
  parseLiveEnvelope,
  parseLiveHello,
  parseLiveSubscriptionChange,
  sanitizeWorkspaceActivity,
} from "../src/shared/live-protocol";

type Inventory = { operations: Array<{ operationId: string; domain: string; method: string; path: string; childPath?: string; transport?: string; runtime: string }> };
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

  test("the public contract is the Hub API and the workspace API is an explicit internal exclusion", async () => {
    const [openapi, inventory, streaming, excluded] = await Promise.all([
      readYaml<{ paths: Record<string, unknown> }>("api/openapi.yaml"),
      readYaml<Inventory>("api/operations.yaml"),
      readYaml<{ channels: Record<string, { path?: string }> }>("api/streaming.yaml"),
      readYaml<{ exclusions: Array<{ id: string; pathPattern?: string; reason?: string }> }>("api/exclusions.yaml"),
    ]);
    expect(Object.keys(openapi.paths).filter(path => path.startsWith("/s/"))).toEqual([]);
    expect(inventory.operations.filter(operation => operation.domain !== "hub" || !operation.operationId.startsWith("hub")).map(operation => operation.operationId)).toEqual([]);
    expect(Object.entries(streaming.channels).filter(([, channel]) => channel.path?.startsWith("/s/")).map(([name]) => name)).toEqual([]);
    expect(excluded.exclusions.find(item => item.id === "workspace-api")?.pathPattern).toBe("/s/{workspaceId}/api/*");
    // The streams the Hub refuses say where their events went.
    for (const id of ["workspace-state-stream-refused", "workspace-inventory-stream-refused", "workspace-conversation-stream-refused", "workspace-activity-stream-refused"]) {
      expect(excluded.exclusions.find(item => item.id === id)?.reason).toContain("/api/hub/live");
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
  test("rejects unknown events, topics, signal kinds, and activity fields", async () => {
    const contract = await readYaml<Streaming & { channels: { cloneJobEvents: { events: Array<{ name: string }> }; live: { events: Array<{ name: string }> } } }>("api/streaming.yaml");
    const ajv = createAjv();
    const compile = (name: string) => ajv.compile(schemaForAjv(contract.schemas[name], contract.schemas));
    expect(compile("ClonePhase")({ phase: "unknown" })).toBe(false);
    expect(contract.channels.cloneJobEvents.events.map(event => event.name)).not.toContain("error");
    expect(contract.channels.live.events.map(event => event.name)).toEqual(["hello", "live"]);

    const envelope = compile("LiveEnvelope");
    const ready = { ws: "uatu", topic: "conversation", key: "opencode:conversation-1", cursor: "", event: { kind: "ready" } };
    expect(envelope(ready)).toBe(true);
    expect(envelope({ ...ready, topic: "terminal" })).toBe(false);
    expect(envelope({ ...ready, event: { kind: "error" } })).toBe(false);
    expect(envelope({ ...ready, event: { kind: "data" } })).toBe(false);
    expect(envelope({ ...ready, event: { kind: "ready", data: {} } })).toBe(false);
    expect(envelope({ ...ready, id: "7" })).toBe(false);

    const activity = compile("WorkspaceActivity");
    expect(activity({ running: true, working: false, awaiting: true })).toBe(true);
    expect(activity({ running: true, working: false })).toBe(false);
    expect(activity({ running: true, working: false, awaiting: true, title: "Fix the build" })).toBe(false);
    expect(compile("LiveHello")({ streamId: "" })).toBe(false);
  });
});

describe("conversation configuration", () => {
  test("configuration requires a model when a variant is present", async () => {
    const openapi = await readYaml<{ components: { schemas: Record<string, object> } }>("api/openapi.yaml");
    const validate = createAjv().compile(schemaForAjv(openapi.components.schemas.ConversationConfiguration, openapi.components.schemas));
    expect(validate({})).toBe(true);
    expect(validate({ model: { providerId: "anthropic", modelId: "claude" }, variant: "high" })).toBe(true);
    expect(validate({ variant: "high" })).toBe(false);
  });

});

describe("live stream topics", () => {
  test("each topic names its payload schema and the domain that owns it", async () => {
    const streaming = await readYaml<{ channels: { live: { topics: Record<string, unknown> } } }>("api/streaming.yaml");
    expect(streaming.channels.live.topics).toMatchObject({
      document: { domain: "workspace", dataSchema: "WorkspaceState" },
      inventory: { domain: "workspace", dataSchema: "ConversationInventoryEvent" },
      conversation: { domain: "workspace", dataSchema: "ChatEvent", resyncDataSchema: "ChatResyncEvent" },
      activity: { domain: "hub", dataSchema: "WorkspaceActivity" },
    });
    expect(Object.keys(streaming.channels.live.topics).sort()).toEqual([...LIVE_TOPICS].sort());
  });

  test("the inventory payload is exact, closed, and carries no conversation identity", async () => {
    const [openapi, fixture] = await Promise.all([
      readYaml<{ components: { schemas: Record<string, object> } }>("api/openapi.yaml"),
      readJson<{ event: string; data: { topic: string; event: { kind: string; data?: unknown } } }>("api/examples/sse/live-inventory.json"),
    ]);
    const validate = createAjv().compile(schemaForAjv(openapi.components.schemas.ConversationInventoryEvent, openapi.components.schemas));
    expect(fixture.event).toBe("live");
    expect(fixture.data.topic).toBe("inventory");
    expect(fixture.data.event).toEqual({ kind: "data", data: { type: "conversation.inventory" } });
    expect(validate(fixture.data.event.data)).toBe(true);
    expect(validate({ type: "conversation.inventory", conversationId: "conversation-1" })).toBe(false);
    expect(validate({ type: "conversation.updated" })).toBe(false);
  });
});

describe("live stream contract agrees with the shared wire protocol", () => {
  test("paths, frames, topics, and bounds", async () => {
    const [openapi, streaming] = await Promise.all([
      readYaml<{ paths: Record<string, unknown>; components: { schemas: Record<string, Record<string, unknown>> } }>("api/openapi.yaml"),
      readYaml<{
        channels: { live: { path: string; bounds: Record<string, number>; lifecycle: Record<string, string> } };
        schemas: Record<string, { properties: { topic: { enum: string[] } } }>;
      }>("api/streaming.yaml"),
    ]);
    expect(streaming.channels.live.path).toBe(LIVE_STREAM_PATH);
    expect(openapi.paths[LIVE_STREAM_PATH]).toBeDefined();
    expect(openapi.paths[`${LIVE_STREAM_PATH}/{streamId}/subscriptions`]).toBeDefined();
    expect(streaming.channels.live.lifecycle.open).toContain(`\`${LIVE_OPEN_FRAME.trim()}\``);
    expect(streaming.channels.live.lifecycle.keepalive).toContain(`\`${LIVE_KEEPALIVE_FRAME.trim()}\``);
    expect(streaming.schemas.LiveEnvelope!.properties.topic.enum).toEqual([...LIVE_TOPICS]);
    expect(streaming.channels.live.bounds).toEqual({
      maxSubscriptions: LIVE_MAX_SUBSCRIPTIONS,
      maxKeyUtf8Bytes: LIVE_MAX_KEY_BYTES,
      maxCursorUtf8Bytes: LIVE_MAX_CURSOR_BYTES,
      maxWorkspaceIdUtf8Bytes: LIVE_MAX_WORKSPACE_ID_BYTES,
      keepaliveSeconds: LIVE_KEEPALIVE_MS / 1000,
    });
    const schemas = openapi.components.schemas;
    expect(schemas.LiveSubscriptionList!.maxItems).toBe(LIVE_MAX_SUBSCRIPTIONS);
    expect(schemas.LiveSubscriptionKeyList!.maxItems).toBe(LIVE_MAX_SUBSCRIPTIONS);
    expect(schemas.LiveCursor!["x-uatu-maxUtf8Bytes"]).toBe(LIVE_MAX_CURSOR_BYTES);
    expect(schemas.LiveDocumentKey!["x-uatu-maxUtf8Bytes"]).toBe(LIVE_MAX_KEY_BYTES);
    expect(schemas.LiveConversationKey!["x-uatu-maxUtf8Bytes"]).toBe(LIVE_MAX_KEY_BYTES);
    // The descriptions state the bounds in prose too; keep them in step.
    expect(String(schemas.LiveDocumentKey!.description)).toContain(`${LIVE_MAX_KEY_BYTES} UTF-8 bytes`);
    expect(String(schemas.LiveConversationKey!.description)).toContain(`${LIVE_MAX_KEY_BYTES} UTF-8 bytes`);
    expect(String(schemas.LiveCursor!.description)).toContain(`${LIVE_MAX_CURSOR_BYTES} UTF-8 bytes`);
  });

  test("the Hub accepts every contract-valid subscription change and the contract states what it refuses", async () => {
    const openapi = await readYaml<{ components: { schemas: Record<string, object> } }>("api/openapi.yaml");
    const validate = createAjv().compile(schemaForAjv(openapi.components.schemas.LiveSubscriptionChange, openapi.components.schemas));
    const accepts = (body: unknown) => !("error" in parseLiveSubscriptionChange(body));
    const valid = [
      {},
      { add: [{ topic: "document" }] },
      { add: [{ topic: "document", key: "compareTarget=last-commit&scope=file&documentId=README.md", cursor: "4" }] },
      { add: [{ topic: "inventory", cursor: "7" }] },
      { add: [{ topic: "conversation", key: "opencode:conversation-1", cursor: "eyJ2IjoxfQ" }], remove: [{ topic: "conversation", key: "opencode:conversation-0" }] },
      { remove: [{ topic: "document", key: "" }, { topic: "inventory" }] },
    ];
    for (const body of valid) {
      expect(validate(body)).toBe(true);
      expect(accepts(body)).toBe(true);
    }
    const refused = [
      { add: [{ topic: "activity" }] },
      { add: [{ topic: "conversation" }] },
      { add: [{ topic: "conversation", key: "" }] },
      { add: [{ topic: "inventory", key: "x" }] },
      { add: Array.from({ length: LIVE_MAX_SUBSCRIPTIONS + 1 }, (_, index) => ({ topic: "conversation", key: `opencode:${index}` })) },
      { replace: [] },
      [],
    ];
    for (const body of refused) {
      expect(validate(body)).toBe(false);
      expect(accepts(body)).toBe(false);
    }
    // Byte bounds are x-uatu-maxUtf8Bytes annotations, which Ajv does not
    // enforce. The bounds test above pins them to the Hub's constants.
    expect(accepts({ add: [{ topic: "conversation", key: "k".repeat(LIVE_MAX_KEY_BYTES + 1) }] })).toBe(false);
    expect(accepts({ add: [{ topic: "inventory", cursor: "c".repeat(LIVE_MAX_CURSOR_BYTES + 1) }] })).toBe(false);
  });

  test("formatted frames and sanitized activity match the published schemas", async () => {
    const streaming = await readYaml<{ schemas: Record<string, object> }>("api/streaming.yaml");
    const compile = (name: string) => createAjv().compile(schemaForAjv(streaming.schemas[name], streaming.schemas));
    const activity = compile("WorkspaceActivity");
    for (const input of [undefined, null, {}, { running: true, working: true, awaiting: true, title: "secret" }, { running: false, working: true }, { running: "yes" }]) {
      expect(activity(sanitizeWorkspaceActivity(input))).toBe(true);
    }
    const frameData = (frame: string) => JSON.parse(frame.split("\n").find(line => line.startsWith("data: "))!.slice("data: ".length));
    expect(formatLiveHello({ streamId: "b7e2" }).startsWith(`event: ${LIVE_HELLO_EVENT}\n`)).toBe(true);
    expect(compile("LiveHello")(frameData(formatLiveHello({ streamId: "b7e2" })))).toBe(true);
    const envelope = compile("LiveEnvelope");
    const envelopes: LiveEnvelope[] = [
      { ws: "uatu", topic: "document", key: "scope=folder", cursor: "1", event: { kind: "data", data: { any: "payload" } } },
      { ws: "uatu", topic: "inventory", cursor: "2", event: { kind: "ready" } },
      { ws: "uatu", topic: "conversation", key: "opencode:c", cursor: "", event: { kind: "resync" } },
      { ws: "uatu", topic: "conversation", key: "opencode:c", cursor: "x", event: { kind: "unavailable" } },
      { ws: "payments-api", topic: "activity", cursor: "3", event: { kind: "data", data: { running: false, working: false, awaiting: false } } },
    ];
    for (const value of envelopes) {
      const frame = formatLiveEnvelope(value);
      expect(frame.startsWith(`event: ${LIVE_ENVELOPE_EVENT}\n`)).toBe(true);
      expect(envelope(frameData(frame))).toBe(true);
    }
  });

  test("the client parser accepts every published live example unchanged", async () => {
    const directory = new URL("examples/sse/", new URL("./", import.meta.url));
    const names = (await readdir(directory)).filter(name => name.startsWith("live-") && name !== "live-hello.json");
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const fixture = await Bun.file(new URL(name, directory)).json() as { event: string; data: unknown };
      expect(fixture.event).toBe(LIVE_ENVELOPE_EVENT);
      expect(parseLiveEnvelope(JSON.stringify(fixture.data))).toEqual(fixture.data as LiveEnvelope);
    }
    const hello = await readJson<{ event: string; data: unknown }>("api/examples/sse/live-hello.json");
    expect(hello.event).toBe(LIVE_HELLO_EVENT);
    expect(parseLiveHello(JSON.stringify(hello.data))).toEqual(hello.data as { streamId: string });
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
        displayName: "Uatu Docs",
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
      workspaces: [{ id: "uatu", displayName: "uatu", path: "/src/uatu", backend: "local", running: true, credentialRestartRequired: false, workspaceApiRevision: 6 }],
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

  test("FolderName accepts exactly the names the server accepts", async () => {
    const openapi = await readYaml<{ components: { schemas: Record<string, { pattern: string }> } }>("api/openapi.yaml");
    const folderName = createAjv().compile(schemaForAjv(openapi.components.schemas.FolderName, openapi.components.schemas));
    // The compilation JSON Schema requires, and the one Ajv and the contract
    // harness both use: ECMA-262 in Unicode mode, matching whole code points.
    const pattern = new RegExp(openapi.components.schemas.FolderName.pattern, "u");

    for (const name of ["new-project", "docs 2", "日本語", "café"]) {
      expect(folderName(name)).toBe(true);
      expect(pattern.test(name)).toBe(true);
    }
    // Every one of these is rejected by the server's folder-name validator:
    // an OpenAPI-valid request must not be able to carry them. The last four
    // are format characters above the BMP, which only a Unicode-mode
    // validator sees as the single code points they are.
    for (const name of [
      "\u{200b}", // zero-width space alone: nonempty, renders blank
      "zero\u{200b}width",
      "project\u{202e}txt", // right-to-left override: displays as a different name
      "\u{ad}soft", // soft hyphen
      "\u{feff}bom", // byte order mark
      "word\u{2060}joiner",
      "ayah\u{6dd}", // Arabic end of ayah
      "\u{180e}mongolian", // Mongolian vowel separator
      "annotation\u{fff9}", // interlinear annotation anchor
      "tag\u{e0020}s", // tag space
      "music\u{1d173}", // musical symbol begin beam
      "\u{110bd}x", // Kaithi number sign
      "\u{e0001}x", // language tag
    ]) {
      expect(folderName(name)).toBe(false);
      expect(pattern.test(name)).toBe(false);
    }

    // Differential sweep over every code point, in the shapes that exercise
    // each clause of the rule: the published pattern and the Hub's own
    // predicate must agree everywhere, or a contract-valid name answers 400.
    const mismatches: string[] = [];
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue; // unpaired surrogates are not characters
      const character = String.fromCodePoint(codePoint);
      for (const name of [character, `a${character}b`, `${character}a`, `.${character}`]) {
        if (pattern.test(name) !== isVisibleFolderName(name)) {
          mismatches.push(`U+${codePoint.toString(16).toUpperCase()} in ${JSON.stringify(name)}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
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
    // Empty is legitimate only for a question marked optional — a rule the
    // schema cannot express per question, so the array admits it and the
    // workspace enforces it against the question itself.
    expect(validate({ kind: "answered", answers: [[]] })).toBe(true);
    expect(validate({ kind: "answered", answers: [["   "]] })).toBe(false);
    expect(validate({ kind: "answered", answers: [[""]] })).toBe(false);
    expect(answered?.items?.minItems).toBe(0);
    expect(answered?.description).toContain("same order");
    expect(answered?.description).toContain("custom strings");
    expect(answered?.description).toContain("optional");
  });
});
