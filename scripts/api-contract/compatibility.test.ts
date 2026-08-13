import { describe, expect, test } from "bun:test";
import { assertCompatibilityPolicy, compareContracts, compareStreamingContracts } from "./compatibility";

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
    expect(result.breaking.hub[0]).toContain("referenced request or response schema changed");
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
      expect.stringContaining("changed response 200 schema"),
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
    expect(compareContracts(base, proposed).breaking.hub).toContain(
      "POST /api/hub/workspaces: changed request schema for application/json",
    );
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
    expect(compareContracts(base, proposed).breaking.workspace).toContain(
      "GET /s/{workspaceId}/api/state: changed path parameter workspaceId schema",
    );
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
});
