import Ajv2020, { type AnySchema } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readdir } from "node:fs/promises";
import { parse } from "yaml";

const root = new URL("../", import.meta.url);
const apiUrl = new URL("api/", root);

export async function readJson<T>(path: string): Promise<T> {
  return Bun.file(new URL(path, root)).json() as Promise<T>;
}

export async function readYaml<T>(path: string): Promise<T> {
  return parse(await Bun.file(new URL(path, root)).text()) as T;
}

export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

export function assertValid(ajv: Ajv2020, schema: AnySchema, value: unknown, label: string): void {
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new Error(`${label}: ${ajv.errorsText(validate.errors, { separator: "\n" })}`);
  }
}

type OpenApi = {
  paths: Record<string, Record<string, { operationId?: string; requestBody?: unknown; responses?: unknown } | unknown>>;
  components: { schemas: Record<string, AnySchema> };
};

export function openApiOperations(document: OpenApi) {
  const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
  return Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method, operation]) => methods.has(method) && operation && typeof operation === "object")
      .map(([method, operation]) => ({
        method: method.toUpperCase(),
        path,
        operationId: (operation as { operationId?: string }).operationId,
        operation: operation as Record<string, unknown>,
      })),
  );
}

export function schemaForAjv(value: unknown, components: Record<string, AnySchema>): AnySchema {
  const rewrite = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(rewrite);
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(Object.entries(candidate as Record<string, unknown>).map(([key, child]) => [
      key,
      key === "$ref" && typeof child === "string"
        ? child.replace("#/components/schemas/", "#/$defs/").replace("#/schemas/", "#/$defs/")
        : rewrite(child),
    ]));
  };
  return { ...(rewrite(value) as Record<string, unknown>), $defs: rewrite(components) };
}

function resolveRef(value: unknown, document: Record<string, unknown>): unknown {
  if (!value || typeof value !== "object" || !("$ref" in value)) return value;
  const ref = (value as { $ref: string }).$ref;
  if (!ref.startsWith("#/")) return value;
  return ref.slice(2).split("/").reduce<unknown>((node, segment) =>
    (node as Record<string, unknown>)[segment.replaceAll("~1", "/").replaceAll("~0", "~")], document);
}

export function validateOpenApiExamples(document: OpenApi): void {
  const ajv = createAjv();
  const rootDocument = document as unknown as Record<string, unknown>;
  for (const { operationId, operation } of openApiOperations(document)) {
    const bodies: Array<[string, unknown]> = [];
    const requestBody = resolveRef(operation.requestBody, rootDocument) as { content?: Record<string, { schema?: unknown; example?: unknown; examples?: Record<string, { value?: unknown }> }> } | undefined;
    if (requestBody?.content) bodies.push(...Object.entries(requestBody.content));
    const responses = operation.responses as Record<string, unknown> | undefined;
    for (const [status, rawResponse] of Object.entries(responses ?? {})) {
      const response = resolveRef(rawResponse, rootDocument) as { content?: Record<string, { schema?: unknown; example?: unknown; examples?: Record<string, { value?: unknown }> }> };
      if (response.content) bodies.push(...Object.entries(response.content).map(([media, content]) => [`${status} ${media}`, content] as [string, unknown]));
    }
    for (const [location, rawContent] of bodies) {
      const content = rawContent as { schema?: unknown; example?: unknown; examples?: Record<string, { value?: unknown }> };
      if (!content.schema) continue;
      const examples = [content.example, ...Object.values(content.examples ?? {}).map(example => example.value)].filter(value => value !== undefined);
      for (const example of examples) {
        assertValid(ajv, schemaForAjv(content.schema, document.components.schemas), example, `${operationId} ${location} example`);
      }
    }
  }
}

type Streaming = {
  schemas: Record<string, AnySchema>;
  channels: Record<string, { topics?: Record<string, { dataSchema?: string; resyncDataSchema?: string }> }>;
};

export async function validateApi(): Promise<void> {
  const [metadata, metadataSchema, openapi, streaming] = await Promise.all([
    readJson<Record<string, unknown>>("api/contract.json"),
    readJson<AnySchema>("api/contract.schema.json"),
    readYaml<OpenApi>("api/openapi.yaml"),
    readYaml<Streaming>("api/streaming.yaml"),
  ]);
  assertValid(createAjv(), metadataSchema, metadata, "contract metadata");
  validateOpenApiExamples(openapi);

  const streamSchemas: Record<string, AnySchema> = {
    ...structuredClone(openapi.components.schemas),
    ...structuredClone(streaming.schemas),
    WorkspaceState: openapi.components.schemas.WorkspaceState!,
    ChatEvent: openapi.components.schemas.ChatEvent!,
    ChatResyncEvent: openapi.components.schemas.ChatResyncEvent!,
    ConversationInventoryEvent: openapi.components.schemas.ConversationInventoryEvent!,
  };
  const validate = (schemaName: string, value: unknown, label: string) => {
    const schema = streamSchemas[schemaName];
    if (!schema) throw new Error(`${label}: no schema named ${schemaName}`);
    assertValid(createAjv(), schemaForAjv(schema, streamSchemas), value, label);
  };
  const topics = streaming.channels.live?.topics ?? {};
  for (const [topic, definition] of Object.entries(topics)) {
    for (const name of [definition.dataSchema, definition.resyncDataSchema]) {
      if (name !== undefined && !streamSchemas[name]) throw new Error(`streaming.yaml live topic ${topic}: unknown schema ${name}`);
    }
  }
  const fixtureSchemas: Record<string, string> = {
    "examples/sse/clone-phase.json": "ClonePhase",
    "examples/sse/clone-output.json": "CloneOutput",
    "examples/sse/clone-result.json": "CloneResult",
    "examples/sse/live-hello.json": "LiveHello",
  };
  // Every example is validated. One without a registered schema fails
  // instead of going unchecked.
  const fixtures = (await readdir(new URL("examples/", apiUrl), { recursive: true }))
    .filter(name => name.endsWith(".json"))
    .map(name => `examples/${name}`)
    .sort();
  if (fixtures.length === 0) throw new Error("api/examples: no examples found");
  for (const relativePath of fixtures) {
    const fixture = await Bun.file(new URL(relativePath, apiUrl)).json() as Record<string, unknown>;
    const sse = relativePath.startsWith("examples/sse/");
    const value = sse && "data" in fixture ? fixture.data : fixture;
    if (sse && fixture.event === "live") {
      // A live frame validates twice: the envelope, then its payload against
      // the schema the topic names in channels.live.topics.
      validate("LiveEnvelope", value, relativePath);
      const envelope = value as { topic: string; event: { kind: string; data?: unknown } };
      if (!("data" in envelope.event)) continue;
      const definition = topics[envelope.topic];
      const payload = envelope.event.kind === "data" ? definition?.dataSchema : definition?.resyncDataSchema;
      if (!payload) throw new Error(`${relativePath}: topic ${envelope.topic} names no schema for a ${envelope.event.kind} payload`);
      validate(payload, envelope.event.data, `${relativePath} ${envelope.topic} payload`);
      continue;
    }
    const schemaName = fixtureSchemas[relativePath];
    if (!schemaName) throw new Error(`${relativePath}: no schema is registered for this example`);
    validate(schemaName, value, relativePath);
  }
}

if (import.meta.main) {
  await validateApi();
  console.log("API metadata, schemas, and examples are valid");
}
