import { describe, expect, test } from "bun:test";
import {
  assertOpenApiResponse,
  assertWebSocketCloseCode,
  assertWebSocketFrame,
  parseNdjson,
  parseSse,
} from "./contract-harness";

const openApi = {
  paths: {
    "/api/hub/state": {
      get: {
        operationId: "hubGetState",
        responses: {
          "200": {
            headers: { "x-request-id": { schema: { type: "string" } } },
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["hubApiRevision"],
                  properties: { hubApiRevision: { type: "integer" } },
                  additionalProperties: false,
                },
              },
            },
          },
          "401": { content: { "application/json": { schema: { type: "object", required: ["error"] } } } },
          "502": { content: { "text/plain": { schema: { type: "string", const: "session unreachable" } } } },
        },
      },
    },
  },
};

describe("black-box HTTP contract validation", () => {
  test("accepts documented success and error responses", async () => {
    await assertOpenApiResponse(openApi, {
      method: "GET",
      path: "/api/hub/state",
      response: Response.json({ hubApiRevision: 1 }, { headers: { "x-request-id": "request-1" } }),
    });
    await assertOpenApiResponse(openApi, {
      method: "GET",
      path: "/api/hub/state",
      response: Response.json({ error: "authentication required" }, { status: 401 }),
    });
  });

  test("names the operation and mismatch", async () => {
    await expect(assertOpenApiResponse(openApi, {
      method: "GET",
      path: "/api/hub/state",
      response: Response.json({ hubApiRevision: "one" }, { headers: { "x-request-id": "request-1" } }),
    })).rejects.toThrow("hubGetState: hubGetState response.hubApiRevision: expected integer");
  });

  test("validates non-JSON response bodies as text", async () => {
    await assertOpenApiResponse(openApi, {
      method: "GET",
      path: "/api/hub/state",
      response: new Response("session unreachable", { status: 502, headers: { "content-type": "text/plain" } }),
    });
    await expect(assertOpenApiResponse(openApi, {
      method: "GET",
      path: "/api/hub/state",
      response: new Response("different error", { status: 502, headers: { "content-type": "text/plain" } }),
    })).rejects.toThrow("expected constant");
  });

  test("enforces constraint siblings beside a $ref (OpenAPI 3.1)", async () => {
    const contract = {
      paths: { "/note": { get: { operationId: "getNote", responses: { "200": { content: { "application/json": { schema: {
        $ref: "#/components/schemas/Note",
        maxLength: 4,
      } } } } } } } },
      components: { schemas: { Note: { type: "string" } } },
    };
    await assertOpenApiResponse(contract, {
      method: "GET",
      path: "/note",
      response: Response.json("ok"),
    });
    await expect(assertOpenApiResponse(contract, {
      method: "GET",
      path: "/note",
      response: Response.json("far too long"),
    })).rejects.toThrow("longer than 4 characters");
  });

  test("a looser sibling cannot shadow the $ref target's own constraint", async () => {
    const contract = {
      paths: { "/note": { get: { operationId: "getNote", responses: { "200": { content: { "application/json": { schema: {
        $ref: "#/components/schemas/ShortNote",
        maxLength: 10,
      } } } } } } } },
      components: { schemas: { ShortNote: { type: "string", maxLength: 4 } } },
    };
    await expect(assertOpenApiResponse(contract, {
      method: "GET",
      path: "/note",
      response: Response.json("sixish"),
    })).rejects.toThrow("longer than 4 characters");
  });

  test("enforces documented numeric and string constraints", async () => {
    const constrained = {
      paths: { "/value": { get: { operationId: "getValue", responses: { "200": { content: { "application/json": { schema: {
        type: "object", required: ["size", "id"], properties: {
          size: { type: "integer", minimum: 1, maximum: 10 },
          id: { type: "string", format: "uuid" },
        },
      } } } } } } } },
    };
    await expect(assertOpenApiResponse(constrained, {
      method: "GET", path: "/value", response: Response.json({ size: 0, id: "not-a-uuid" }),
    })).rejects.toThrow("less than minimum 1");
  });
});

describe("streaming contract observations", () => {
  test("parses SSE replay identity and JSON payloads", () => {
    expect(parseSse('id: 7\nevent: phase\ndata: {"status":"succeeded"}\n\n')).toEqual([
      { id: "7", event: "phase", data: { status: "succeeded" } },
    ]);
    expect(() => parseSse("event: phase\ndata: nope\n\n")).toThrow("phase");
  });

  test("parses NDJSON item boundaries with useful errors", () => {
    expect(parseNdjson('{"type":"match"}\n{"type":"complete"}\n')).toHaveLength(2);
    expect(() => parseNdjson('{"type":"match"}\nnope\n')).toThrow("NDJSON item 2");
  });

  test("validates WebSocket controls while preserving binary PTY frames", () => {
    const controls = {
      "attach-ready": {
        type: "object",
        required: ["type", "cols", "rows"],
        properties: {
          type: { const: "attach-ready" },
          cols: { type: "integer" },
          rows: { type: "integer" },
        },
      },
    };
    expect(() => assertWebSocketFrame(JSON.stringify({ type: "attach-ready", cols: 80, rows: 24 }), controls, true)).not.toThrow();
    expect(() => assertWebSocketFrame(new Uint8Array([1, 2]), controls, true)).not.toThrow();
    expect(() => assertWebSocketFrame('{"type":"mystery"}', controls, true)).toThrow("undocumented control frame");
    expect(() => assertWebSocketCloseCode(4410, [1000, 4001, 4410])).not.toThrow();
    expect(() => assertWebSocketCloseCode(4999, [1000, 4001, 4410])).toThrow("undocumented close code 4999");
  });
});
