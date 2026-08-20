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
