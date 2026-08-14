import { describe, expect, test } from "bun:test";
import { assertCompatibilityPolicy, compareContracts, compareExclusions, compareInventories, compareStreamingContracts } from "./compatibility";

const operation = (tag: string, responses: Record<string, unknown> = { "200": {} }) => ({
  tags: [tag],
  responses,
});

describe("API compatibility policy", () => {
  test("accepts additive changes without a revision increment", () => {
    const base = { paths: { "/api/hub/state": { get: operation("Hub") } } };
    const proposed = { paths: { ...base.paths, "/api/hub/browse": { get: operation("Hub") } } };
    const result = compareContracts(base, proposed);
    expect(result.changedDomains).toEqual(["hub"]);
    expect(() => assertCompatibilityPolicy(result, { hubApiRevision: 1, workspaceApiRevision: 1 }, { hubApiRevision: 1, workspaceApiRevision: 1 }, "")).not.toThrow();
  });

  test("requires only the affected domain revision and migration guidance", () => {
    const base = { paths: { "/s/{workspaceId}/api/state": { get: operation("Workspace", { "200": {}, "401": {} }) } } };
    const proposed = { paths: { "/s/{workspaceId}/api/state": { get: operation("Workspace", { "200": {} }) } } };
    const result = compareContracts(base, proposed);
    expect(() => assertCompatibilityPolicy(result, { hubApiRevision: 3, workspaceApiRevision: 4 }, { hubApiRevision: 3, workspaceApiRevision: 4 }, ""))
      .toThrow("workspace: breaking change requires a revision greater than 4");
    expect(() => assertCompatibilityPolicy(result, { hubApiRevision: 3, workspaceApiRevision: 4 }, { hubApiRevision: 3, workspaceApiRevision: 5 }, "## Hub 3 / Workspace 5 - Unreleased\n\n### Migration\n\nWorkspace clients must stop handling 401."))
      .not.toThrow();
  });

  test("does not reuse migration guidance from an older revision entry", () => {
    const result = compareContracts(
      { paths: { "/api/hub/state": { get: operation("Hub", { "200": {}, "401": {} }) } } },
      { paths: { "/api/hub/state": { get: operation("Hub", { "200": {} }) } } },
    );
    const changelog = [
      "## Hub 2 / Workspace 1 - Unreleased",
      "",
      "### Migration",
      "",
      "None.",
      "",
      "## Hub 1 / Workspace 1",
      "",
      "### Migration",
      "",
      "Hub clients must update their status handling.",
    ].join("\n");
    expect(() => assertCompatibilityPolicy(result, { hubApiRevision: 1, workspaceApiRevision: 1 }, { hubApiRevision: 2, workspaceApiRevision: 1 }, changelog))
      .toThrow("hub: breaking change requires changelog migration guidance");
  });

  test("reports removed operation identity", () => {
    const result = compareContracts({ paths: { "/api/hub/state": { get: operation("Hub") } } }, { paths: {} });
    expect(result.breaking.hub).toEqual(["GET /api/hub/state: operation removed"]);
  });

  test("attributes referenced component changes to the operation domain", () => {
    const base = {
      paths: { "/api/hub/state": { get: { ...operation("Hub"), responses: { "200": { $ref: "#/components/responses/State" } } } } },
      components: { responses: { State: { content: { "application/json": { schema: { type: "string" } } } } } },
    };
    const proposed = structuredClone(base);
    proposed.components.responses.State.content["application/json"].schema.type = "integer";
    const result = compareContracts(base, proposed);
    expect(result.changedDomains).toEqual(["hub"]);
    expect(result.breaking.hub[0]).toContain("response 200 schema for application/json");
  });

  test("treats referenced-component annotation and additive changes as non-breaking", () => {
    const base = {
      paths: { "/api/hub/workspaces": { post: {
        ...operation("Hub"),
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/CreateWorkspaceRequest" } } } },
      } } },
      components: { schemas: { CreateWorkspaceRequest: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string", description: "Absolute path" } },
        additionalProperties: false,
      } } },
    };
    const proposed = structuredClone(base);
    const schema = proposed.components.schemas.CreateWorkspaceRequest;
    schema.properties.path.description = "Absolute folder path";
    (schema.properties as Record<string, unknown>).template = { type: "string" };
    const result = compareContracts(base, proposed);
    expect(result.changedDomains).toEqual(["hub"]);
    expect(result.breaking.hub).toEqual([]);
  });

  test("constraint siblings beside an unchanged $ref participate in comparison", () => {
    const contract = (maxLength: number | undefined) => ({
      paths: { "/api/hub/clone-jobs": { post: {
        ...operation("Hub"),
        requestBody: { content: { "application/json": { schema: {
          $ref: "#/components/schemas/CloneJobInput",
          ...(maxLength === undefined ? {} : { maxLength }),
        } } } },
      } } },
      components: { schemas: { CloneJobInput: { type: "object", required: ["input"], properties: { input: { type: "string" } }, additionalProperties: false } } },
    });
    // Adding a constraint sibling turns the resolved shape into an allOf
    // conjunction, so the break reports as a structural change rather than
    // naming the keyword — what matters is that it is breaking at all.
    const narrowed = compareContracts(contract(undefined), contract(4096));
    expect(narrowed.breaking.hub.length).toBeGreaterThan(0);
    const unchanged = compareContracts(contract(4096), contract(4096));
    expect(unchanged.breaking.hub).toEqual([]);
  });

  test("a sibling keyword cannot shadow a change to the same keyword in the $ref target", () => {
    // Both constraints apply (conjunction); a merge would resolve to the
    // sibling's maxLength on both sides and hide the component tightening.
    const contract = (targetMax: number) => ({
      paths: { "/api/hub/clone-jobs": { post: {
        ...operation("Hub"),
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Input", maxLength: 20 } } } },
      } } },
      components: { schemas: { Input: { type: "string", maxLength: targetMax } } },
    });
    const result = compareContracts(contract(10), contract(5));
    expect(result.breaking.hub.some(item => item.includes("maxLength"))).toBe(true);
  });

  test("still breaks on removed or newly required referenced properties", () => {
    const base = {
      paths: { "/api/hub/workspaces": { post: {
        ...operation("Hub"),
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/CreateWorkspaceRequest" } } } },
      } } },
      components: { schemas: { CreateWorkspaceRequest: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" }, init: { type: "boolean" } },
        additionalProperties: false,
      } } },
    };
    const removed = structuredClone(base);
    delete (removed.components.schemas.CreateWorkspaceRequest.properties as Record<string, unknown>).init;
    expect(compareContracts(base, removed).breaking.hub.some(item => item.includes("removed property init"))).toBe(true);
    const required = structuredClone(base);
    required.components.schemas.CreateWorkspaceRequest.required = ["path", "init"];
    expect(compareContracts(base, required).breaking.hub.some(item => item.includes("init became required"))).toBe(true);
  });

  test("added property in a closed response object is breaking, in an open one it is not", () => {
    const contract = (extra: boolean, closed: boolean) => ({
      paths: { "/api/hub/state": { get: {
        ...operation("Hub"),
        responses: { "200": { content: { "application/json": { schema: {
          type: "object",
          required: ["version"],
          properties: { version: { type: "string" }, ...(extra ? { flavor: { type: "string" } } : {}) },
          ...(closed ? { additionalProperties: false } : {}),
        } } } } },
      } } },
    });
    expect(compareContracts(contract(false, true), contract(true, true)).breaking.hub.some(item => item.includes("added property flavor"))).toBe(true);
    expect(compareContracts(contract(false, false), contract(true, false)).breaking.hub).toEqual([]);
  });

  test("changing a security scheme definition breaks every domain referencing it", () => {
    const base = {
      security: [{ hubCookie: [] }],
      paths: {
        "/api/hub/state": { get: operation("Hub") },
        "/s/{workspaceId}/api/state": { get: operation("Workspace") },
      },
      components: { securitySchemes: { hubCookie: { type: "apiKey", in: "cookie", name: "uatu_hub" } } },
    };
    const proposed = structuredClone(base);
    proposed.components.securitySchemes.hubCookie.name = "uatu_session";
    const result = compareContracts(base, proposed);
    expect(result.breaking.hub).toContain("security scheme hubCookie: definition changed");
    expect(result.breaking.workspace).toContain("security scheme hubCookie: definition changed");
  });

  test("removing or changing a documented response header is breaking", () => {
    const base = { paths: { "/login": { post: {
      ...operation("Hub"),
      responses: { "200": { headers: { "Set-Cookie": { schema: { type: "string" } } }, content: {} } },
    } } } };
    const removed = structuredClone(base);
    delete (removed.paths["/login"].post.responses["200"].headers as Record<string, unknown>)["Set-Cookie"];
    expect(compareContracts(base, removed).breaking.hub).toContain("POST /login: removed response 200 header Set-Cookie");
    const changed = structuredClone(base);
    changed.paths["/login"].post.responses["200"].headers["Set-Cookie"].schema = { type: "integer" };
    expect(compareContracts(base, changed).breaking.hub.some(item => item.includes("header Set-Cookie schema"))).toBe(true);
  });

  test("detects authentication, requiredness, and inline response schema breaks", () => {
    const base = { paths: { "/api/hub/state": { get: {
      ...operation("Hub"),
      security: [{ hubBearer: [] }],
      parameters: [{ name: "scope", in: "query", schema: { type: "string" } }],
      responses: { "200": { content: { "application/json": { schema: { type: "string" } } } } },
    } } } };
    const proposed = structuredClone(base);
    const next = proposed.paths["/api/hub/state"].get;
    next.security = [{ hubCookie: [] }];
    next.parameters[0]!.required = true;
    next.responses["200"].content["application/json"].schema.type = "integer";
    expect(compareContracts(base, proposed).breaking.hub).toEqual(expect.arrayContaining([
      expect.stringContaining("required"),
      expect.stringContaining("response 200 schema for application/json"),
      expect.stringContaining("authentication"),
    ]));
  });

  test("detects changes to inherited authentication requirements", () => {
    const paths = { "/api/hub/state": { get: operation("Hub") } };
    const base = { security: [{ hubBearer: [] }], paths };
    const proposed = { security: [{ hubCookie: [] }], paths };
    expect(compareContracts(base, proposed).breaking.hub).toContain(
      "GET /api/hub/state: changed authentication requirements",
    );
  });

  test("detects changes to inline request schemas", () => {
    const base = { paths: { "/api/hub/workspaces": { post: {
      ...operation("Hub"),
      requestBody: { content: { "application/json": { schema: { type: "object", properties: { start: { type: "boolean" } } } } } },
    } } } };
    const proposed = structuredClone(base);
    proposed.paths["/api/hub/workspaces"].post.requestBody.content["application/json"].schema.properties.start = { type: "string" };
    expect(compareContracts(base, proposed).breaking.hub.some(item =>
      item.includes("request schema for application/json") && item.includes("changed type"),
    )).toBe(true);
  });

  test("preserves an operation-level authentication override", () => {
    const paths = { "/api/hub/state": { get: { ...operation("Hub"), security: [] } } };
    const base = { security: [{ hubBearer: [] }], paths };
    const proposed = { security: [{ hubCookie: [] }], paths };
    expect(compareContracts(base, proposed).changedDomains).toEqual([]);
  });

  test("attributes existing streaming protocol changes to their domain", () => {
    const base = { channels: { state: { path: "/s/{workspaceId}/api/events", events: [{ name: "state" }] } } };
    const proposed = { channels: { state: { path: "/s/{workspaceId}/api/events", events: [{ name: "snapshot" }] } } };
    expect(compareStreamingContracts(base, proposed).breaking.workspace).toEqual([
      "streaming channel state: existing protocol changed",
    ]);
  });

  test("detects changes to path-level parameters", () => {
    const base = { paths: { "/s/{workspaceId}/api/state": {
      parameters: [{ name: "workspaceId", in: "path", required: true, schema: { type: "string" } }],
      get: operation("Workspace"),
    } } };
    const proposed = structuredClone(base);
    proposed.paths["/s/{workspaceId}/api/state"].parameters[0]!.schema = { type: "integer" };
    expect(compareContracts(base, proposed).breaking.workspace.some(item =>
      item.includes("path parameter workspaceId schema"),
    )).toBe(true);
  });

  test("changing parameter serialization is breaking even with an unchanged schema", () => {
    const contract = (explode: boolean | undefined) => ({ paths: { "/api/hub/browse": { get: {
      ...operation("Hub"),
      parameters: [{ name: "kinds", in: "query", schema: { type: "array", items: { type: "string" } }, style: "form", ...(explode === undefined ? {} : { explode }) }],
    } } } });
    const result = compareContracts(contract(true), contract(false));
    expect(result.breaking.hub).toContain("GET /api/hub/browse: changed query parameter kinds explode");
    const styled = compareContracts(contract(undefined), contract(undefined));
    expect(styled.breaking.hub).toEqual([]);
  });

  test("detects removal of an optional parameter", () => {
    const base = { paths: { "/api/hub/browse": { get: {
      ...operation("Hub"),
      parameters: [{ name: "path", in: "query", schema: { type: "string" } }],
    } } } };
    const proposed = { paths: { "/api/hub/browse": { get: operation("Hub") } } };
    expect(compareContracts(base, proposed).breaking.hub).toContain(
      "GET /api/hub/browse: removed query parameter path",
    );
  });

  test("streaming schema body changes are detected as breaking", () => {
    const streaming = (phases: string[]) => ({
      channels: { cloneJobEvents: { path: "/api/hub/clone-jobs/{jobId}/events", events: [{ name: "phase", dataSchema: "ClonePhase" }] } },
      schemas: { ClonePhase: { type: "object", required: ["phase"], properties: { phase: { enum: phases } }, additionalProperties: false } },
    });
    const result = compareStreamingContracts(streaming(["cloning", "registering"]), streaming(["cloning", "registering", "starting"]));
    expect(result.changedDomains).toEqual(["hub"]);
    expect(result.breaking.hub.some(item => item.includes("schema ClonePhase") && item.includes("starting"))).toBe(true);
  });

  test("streaming schema description-only changes are changed but not breaking", () => {
    const streaming = (description: string) => ({
      channels: { search: { path: "/s/{workspaceId}/api/search", itemSchema: "SearchDone" } },
      schemas: { SearchDone: { type: "object", required: ["kind"], properties: { kind: { const: "done", description } }, additionalProperties: false } },
    });
    const result = compareStreamingContracts(streaming("before"), streaming("after"));
    expect(result.changedDomains).toEqual(["workspace"]);
    expect(result.breaking.workspace).toEqual([]);
  });

  test("streaming client-frame schemas compare with request-direction rules", () => {
    const streaming = (max: number | undefined) => ({
      channels: { terminal: { path: "/s/{workspaceId}/api/terminal", clientFrames: { textJson: { schemas: ["TerminalResize"] } } } },
      schemas: { TerminalResize: { type: "object", required: ["type", "cols"], properties: { type: { const: "resize" }, cols: { type: "integer", ...(max === undefined ? {} : { maximum: max }) } }, additionalProperties: false } },
    });
    // Constraint change on a client frame is breaking (conservative default).
    expect(compareStreamingContracts(streaming(1000), streaming(500)).breaking.workspace.length).toBeGreaterThan(0);
  });

  test("streaming schemas resolve external openapi.yaml references", () => {
    const streaming = { channels: { state: { path: "/s/{workspaceId}/api/events", events: [{ name: "state", dataSchema: "WorkspaceState" }] } }, schemas: { WorkspaceState: { $ref: "./openapi.yaml#/components/schemas/WorkspaceState" } } };
    const openapi = (type: string) => ({ components: { schemas: { WorkspaceState: { type: "object", required: ["generatedAt"], properties: { generatedAt: { type } }, additionalProperties: false } } } });
    const result = compareStreamingContracts(streaming, structuredClone(streaming), openapi("number"), openapi("string"));
    expect(result.breaking.workspace.some(item => item.includes("schema WorkspaceState") && item.includes("changed type"))).toBe(true);
  });

  test("inventory wire-field mutations and removals are breaking; additions are changed", () => {
    const inventory = (entries: Record<string, unknown>[]) => ({ operations: entries });
    const entry = { operationId: "hubGetState", domain: "hub", method: "GET", path: "/api/hub/state", auth: "hubSession", statuses: [200, 401], requestMediaTypes: [], responseMediaTypes: ["application/json"] };
    const removed = compareInventories(inventory([entry]), inventory([]));
    expect(removed.breaking.hub).toContain("inventory: removed operation hubGetState");
    const mutated = compareInventories(inventory([entry]), inventory([{ ...entry, path: "/api/hub/status" }]));
    expect(mutated.breaking.hub).toContain("inventory: operation hubGetState changed path");
    const statusRemoved = compareInventories(inventory([entry]), inventory([{ ...entry, statuses: [200] }]));
    expect(statusRemoved.breaking.hub.some(item => item.includes("removed statuses"))).toBe(true);
    const statusAdded = compareInventories(inventory([entry]), inventory([{ ...entry, statuses: [200, 401, 403] }]));
    expect(statusAdded.breaking.hub).toEqual([]);
    expect(statusAdded.changedDomains).toEqual(["hub"]);
    const added = compareInventories(inventory([entry]), inventory([entry, { ...entry, operationId: "hubBrowse", path: "/api/hub/browse" }]));
    expect(added.breaking.hub).toEqual([]);
    expect(added.changedDomains).toEqual(["hub"]);
  });

  test("exclusion changes are changed-only and scoped to their domain", () => {
    const exclusions = (entries: Record<string, unknown>[]) => ({ exclusions: entries });
    const entry = { id: "hub-dashboard", scope: "hub", methods: ["GET"], path: "/", reason: "HTML shell" };
    const removed = compareExclusions(exclusions([entry]), exclusions([]));
    expect(removed.changedDomains).toEqual(["hub"]);
    expect(removed.breaking.hub).toEqual([]);
    const testOnly = compareExclusions(exclusions([{ id: "e2e-reset", scope: "test", path: "/__e2e/reset" }]), exclusions([]));
    expect(testOnly.changedDomains).toEqual([]);
  });
});
