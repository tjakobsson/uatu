import { parse } from "yaml";
import openapiSource from "../../../api/openapi.yaml?raw";

type JsonObject = Record<string, unknown>;

export type ApiSchemaRef = { label: string; anchor?: string };
export type ApiMedia = { type: string; schema?: ApiSchemaRef };
export type ApiParameter = { name: string; location: string; required: boolean; description: string; schema?: ApiSchemaRef };
export type ApiResponse = { status: string; description: string; media: ApiMedia[] };
export type ApiOperation = {
  id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  parameters: ApiParameter[];
  requestMedia: ApiMedia[];
  responses: ApiResponse[];
};
export type ApiSchema = { name: string; description: string; summary: string; json: string };
export type ApiReference = { operations: ApiOperation[]; schemas: ApiSchema[] };

const httpMethods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function resolve(document: JsonObject, value: unknown): JsonObject {
  const candidate = object(value);
  if (typeof candidate.$ref !== "string" || !candidate.$ref.startsWith("#/")) return candidate;
  return candidate.$ref.slice(2).split("/").reduce<JsonObject>((node, part) =>
    object(node[part.replaceAll("~1", "/").replaceAll("~0", "~")]), document);
}

function schemaRef(value: unknown): ApiSchemaRef | undefined {
  const schema = object(value);
  if (Object.keys(schema).length === 0) return undefined;
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.split("/").at(-1) ?? schema.$ref;
    return { label: name, anchor: schema.$ref.startsWith("#/components/schemas/") ? `schema-${name}` : undefined };
  }
  if (Array.isArray(schema.type)) return { label: schema.type.map(String).join(" | ") };
  if (typeof schema.type === "string") return { label: schema.type };
  if (Array.isArray(schema.enum)) return { label: schema.enum.map(String).join(" | ") };
  if (Array.isArray(schema.oneOf)) return { label: `one of ${schema.oneOf.length} schemas` };
  if (Array.isArray(schema.allOf)) return { label: `all of ${schema.allOf.length} schemas` };
  if ("const" in schema) return { label: JSON.stringify(schema.const) };
  return { label: "schema" };
}

function media(document: JsonObject, content: unknown): ApiMedia[] {
  return Object.entries(object(content)).map(([type, contract]) => ({
    type,
    schema: schemaRef(resolve(document, contract).schema),
  }));
}

function parameter(document: JsonObject, value: unknown): ApiParameter {
  const item = resolve(document, value);
  return {
    name: String(item.name ?? "parameter"),
    location: String(item.in ?? "unknown"),
    required: item.required === true,
    description: typeof item.description === "string" ? item.description : "",
    schema: schemaRef(item.schema),
  };
}

function schemaSummary(value: unknown): string {
  const schema = object(value);
  if (Array.isArray(schema.oneOf)) return `${schema.oneOf.length} variants`;
  if (Array.isArray(schema.allOf)) return `${schema.allOf.length} combined schemas`;
  const type = Array.isArray(schema.type) ? schema.type.join(" | ") : String(schema.type ?? "schema");
  const properties = Object.keys(object(schema.properties));
  return properties.length > 0 ? `${type} · ${properties.length} properties` : type;
}

export function readApiReference(source = openapiSource): ApiReference {
  const document = object(parse(source));
  const operations: ApiOperation[] = [];
  for (const [path, pathValue] of Object.entries(object(document.paths))) {
    const pathItem = object(pathValue);
    const inheritedParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const [method, candidate] of Object.entries(pathItem)) {
      if (!httpMethods.has(method.toLowerCase()) || !candidate || typeof candidate !== "object") continue;
      const operation = object(candidate);
      if (typeof operation.operationId !== "string") continue;
      const operationParameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      const requestBody = resolve(document, operation.requestBody);
      const responses = Object.entries(object(operation.responses)).map(([status, responseValue]) => {
        const response = resolve(document, responseValue);
        return {
          status,
          description: typeof response.description === "string" ? response.description : "",
          media: media(document, response.content),
        };
      });
      operations.push({
        id: operation.operationId,
        method: method.toUpperCase(),
        path,
        summary: typeof operation.summary === "string" ? operation.summary : operation.operationId,
        description: typeof operation.description === "string" ? operation.description : "",
        tags: Array.isArray(operation.tags) ? operation.tags.filter((tag): tag is string => typeof tag === "string") : [],
        parameters: [...inheritedParameters, ...operationParameters].map(value => parameter(document, value)),
        requestMedia: media(document, requestBody.content),
        responses,
      });
    }
  }
  const schemas = Object.entries(object(object(document.components).schemas)).map(([name, value]) => {
    const schema = object(value);
    return {
      name,
      description: typeof schema.description === "string" ? schema.description : "",
      summary: schemaSummary(schema),
      json: JSON.stringify(schema, null, 2),
    };
  });
  return {
    operations: operations.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
    schemas: schemas.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function readOperations(source = openapiSource): ApiOperation[] {
  return readApiReference(source).operations;
}
