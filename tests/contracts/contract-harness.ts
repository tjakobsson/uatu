import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

type JsonObject = Record<string, unknown>;

export type OpenApiObservation = {
  method: string;
  path: string;
  response: Response;
};

function object(value: unknown, context: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context}: expected an object`);
  }
  return value as JsonObject;
}

function pointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new Error(`unsupported external schema reference ${ref}`);
  return ref.slice(2).split("/").reduce<unknown>((value, part) => {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    return object(value, `reference ${ref}`)[key];
  }, root);
}

function schemaError(root: unknown, schemaValue: unknown, value: unknown, at: string): string | undefined {
  const schema = object(schemaValue, `${at} schema`);
  if (typeof schema.$ref === "string") {
    // OpenAPI 3.1 allows constraints beside $ref (both apply); merge them
    // over the resolved target so sibling keywords still validate.
    const target = object(pointer(root, schema.$ref), `reference ${schema.$ref}`);
    const { $ref: _ignored, ...siblings } = schema;
    return schemaError(root, Object.keys(siblings).length === 0 ? target : { ...target, ...siblings }, value, at);
  }
  if (schema.nullable === true && value === null) return undefined;
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const variants = (schema.oneOf ?? schema.anyOf) as unknown[];
    if (variants.some(variant => schemaError(root, variant, value, at) === undefined)) return undefined;
    return `${at}: did not match any documented schema variant`;
  }
  if (Array.isArray(schema.allOf)) {
    for (const variant of schema.allOf) {
      const error = schemaError(root, variant, value, at);
      if (error) return error;
    }
  }
  if ("const" in schema && value !== schema.const) return `${at}: expected constant ${JSON.stringify(schema.const)}`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${at}: undocumented value ${JSON.stringify(value)}`;

  const expected = schema.type;
  if (Array.isArray(expected)) {
    const matches = expected.some(type =>
      (type === "null" && value === null)
      || (type === "string" && typeof value === "string")
      || (type === "boolean" && typeof value === "boolean")
      || (type === "integer" && Number.isInteger(value))
      || (type === "number" && typeof value === "number")
      || (type === "array" && Array.isArray(value))
      || (type === "object" && !!value && typeof value === "object" && !Array.isArray(value)));
    if (!matches) return `${at}: expected one of ${expected.join(", ")}`;
  }
  if (expected === "object" || schema.properties || schema.required) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${at}: expected object`;
    const record = value as JsonObject;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in record)) return `${at}.${key}: required property is missing`;
    }
    const properties = (schema.properties as JsonObject | undefined) ?? {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in record) {
        const error = schemaError(root, propertySchema, record[key], `${at}.${key}`);
        if (error) return error;
      }
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(record).find(key => !(key in properties));
      if (extra) return `${at}.${extra}: undocumented property`;
    }
    return undefined;
  }
  if (expected === "array") {
    if (!Array.isArray(value)) return `${at}: expected array`;
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${at}: fewer than ${schema.minItems} items`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${at}: more than ${schema.maxItems} items`;
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const error = schemaError(root, schema.items, value[index], `${at}[${index}]`);
        if (error) return error;
      }
    }
    return undefined;
  }
  if (expected === "string" && typeof value !== "string") return `${at}: expected string`;
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${at}: shorter than ${schema.minLength} characters`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${at}: longer than ${schema.maxLength} characters`;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return `${at}: does not match pattern ${schema.pattern}`;
    if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return `${at}: expected UUID`;
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) return `${at}: expected date-time`;
    if (schema.format === "uri" && !URL.canParse(value)) return `${at}: expected URI`;
  }
  if (expected === "boolean" && typeof value !== "boolean") return `${at}: expected boolean`;
  if (expected === "integer" && !Number.isInteger(value)) return `${at}: expected integer`;
  if (expected === "number" && typeof value !== "number") return `${at}: expected number`;
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${at}: less than minimum ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${at}: greater than maximum ${schema.maximum}`;
  }
  return undefined;
}

export async function loadContract(path: string): Promise<JsonObject> {
  return object(parseYaml(await readFile(path, "utf8")), path);
}

export async function assertOpenApiResponse(openApi: JsonObject, observation: OpenApiObservation): Promise<void> {
  const operation = object(object(openApi.paths, "OpenAPI paths")[observation.path], observation.path)[observation.method.toLowerCase()];
  const operationObject = object(operation, `${observation.method} ${observation.path}`);
  const operationId = typeof operationObject.operationId === "string"
    ? operationObject.operationId
    : `${observation.method.toUpperCase()} ${observation.path}`;
  const responses = object(operationObject.responses, `${operationId} responses`);
  const responseContract = responses[String(observation.response.status)] ?? responses.default;
  if (!responseContract) {
    throw new Error(`${operationId}: undocumented response status ${observation.response.status}`);
  }
  const documented = object(
    typeof object(responseContract, `${operationId} response`).$ref === "string"
      ? pointer(openApi, object(responseContract, `${operationId} response`).$ref as string)
      : responseContract,
    `${operationId} response ${observation.response.status}`,
  );
  const headers = (documented.headers as JsonObject | undefined) ?? {};
  for (const name of Object.keys(headers)) {
    if (!observation.response.headers.has(name)) throw new Error(`${operationId}: missing documented response header ${name}`);
  }
  const media = (documented.content as JsonObject | undefined) ?? {};
  if (Object.keys(media).length === 0 || observation.response.status === 204) return;
  const contentType = observation.response.headers.get("content-type")?.split(";", 1)[0] ?? "";
  const mediaContract = media[contentType];
  if (!mediaContract) throw new Error(`${operationId}: undocumented response media type ${contentType || "<missing>"}`);
  const jsonMedia = contentType === "application/json" || contentType.endsWith("+json");
  const body = jsonMedia
    ? await observation.response.clone().json().catch(() => {
      throw new Error(`${operationId}: response body is not valid JSON`);
    })
    : await observation.response.clone().text();
  const schema = object(mediaContract, `${operationId} ${contentType}`).schema;
  if (schema) {
    const error = schemaError(openApi, schema, body, `${operationId} response`);
    if (error) throw new Error(`${operationId}: ${error}`);
  }
}

export type SseEvent = { id?: string; event: string; data: unknown };

export function parseSse(source: string): SseEvent[] {
  return source.split(/\r?\n\r?\n/).filter(Boolean).map((block, index) => {
    let id: string | undefined;
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
      if (field === "id") id = value;
      if (field === "event") event = value;
      if (field === "data") data.push(value);
    }
    if (data.length === 0) throw new Error(`SSE event ${index + 1}: missing data field`);
    const raw = data.join("\n");
    try {
      return { id, event, data: JSON.parse(raw) };
    } catch {
      throw new Error(`SSE event ${index + 1} (${event}): data is not valid JSON`);
    }
  });
}

export function parseNdjson(source: string): unknown[] {
  return source.split(/\r?\n/).filter(line => line.trim() !== "").map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`NDJSON item ${index + 1}: invalid JSON`);
    }
  });
}

export function assertSchema(contract: JsonObject, schema: unknown, value: unknown, label: string): void {
  const error = schemaError(contract, schema, value, label);
  if (error) throw new Error(error);
}

export function assertWebSocketFrame(frame: unknown, controlSchemas: JsonObject, binaryAllowed: boolean): void {
  if (frame instanceof ArrayBuffer || ArrayBuffer.isView(frame) || frame instanceof Blob) {
    if (!binaryAllowed) throw new Error("WebSocket: undocumented binary frame");
    return;
  }
  if (typeof frame !== "string") throw new Error("WebSocket: unsupported frame value");
  let control: unknown;
  try {
    control = JSON.parse(frame);
  } catch {
    throw new Error("WebSocket: text control frame is not valid JSON");
  }
  const type = object(control, "WebSocket control frame").type;
  if (typeof type !== "string" || !controlSchemas[type]) {
    throw new Error(`WebSocket: undocumented control frame ${JSON.stringify(type)}`);
  }
  assertSchema({ components: { schemas: controlSchemas } }, controlSchemas[type], control, `WebSocket ${type}`);
}

export function assertWebSocketCloseCode(code: number, documentedCodes: number[]): void {
  if (!documentedCodes.includes(code)) throw new Error(`WebSocket: undocumented close code ${code}`);
}
