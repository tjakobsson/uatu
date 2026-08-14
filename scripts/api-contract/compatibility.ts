import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

type JsonObject = Record<string, unknown>;
export type ApiDomain = "hub" | "workspace";
export type CompatibilityResult = {
  changedDomains: ApiDomain[];
  breaking: Record<ApiDomain, string[]>;
};

// Wire direction of a schema: request-side schemas may gain optional inputs
// compatibly, response-side schemas may not surprise old strict validators.
type Direction = "request" | "response";

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function domainFor(path: string, operation: JsonObject): ApiDomain {
  const tags = Array.isArray(operation.tags) ? operation.tags.map(String) : [];
  if (tags.some(tag => tag.toLowerCase().startsWith("workspace")) || path.startsWith("/s/")) return "workspace";
  return "hub";
}

function operations(contract: JsonObject): Map<string, { domain: ApiDomain; value: JsonObject }> {
  const result = new Map<string, { domain: ApiDomain; value: JsonObject }>();
  const inheritedSecurity = contract.security;
  for (const [path, pathItem] of Object.entries(object(contract.paths))) {
    const inheritedParameters = Array.isArray(object(pathItem).parameters)
      ? object(pathItem).parameters as unknown[]
      : [];
    for (const [method, value] of Object.entries(object(pathItem))) {
      if (!new Set(["get", "post", "put", "patch", "delete", "head", "options"]).has(method)) continue;
      const operationValue = object(value);
      const operationParameters = Array.isArray(operationValue.parameters) ? operationValue.parameters : [];
      const operation = {
        ...operationValue,
        parameters: [...inheritedParameters, ...operationParameters],
        security: Object.hasOwn(operationValue, "security") ? operationValue.security : inheritedSecurity,
      };
      result.set(`${method.toUpperCase()} ${path}`, { domain: domainFor(path, operation), value: operation });
    }
  }
  return result;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Documentation-only keys that never change what is valid on the wire.
const ANNOTATION_KEYS = new Set(["description", "title", "summary", "example", "examples", "default", "$comment", "externalDocs", "meaning", "deprecated"]);

function stripAnnotations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAnnotations);
  if (!value || typeof value !== "object") return value;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value as JsonObject)) {
    if (ANNOTATION_KEYS.has(key)) continue;
    result[key] = stripAnnotations(item);
  }
  return result;
}

function pointerTarget(pointer: string, document: JsonObject): unknown {
  return pointer.split("/").filter(Boolean).reduce<unknown>((node, segment) =>
    object(node)[segment.replaceAll("~1", "/").replaceAll("~0", "~")], document);
}

// Deep-resolves $ref nodes so schema comparison sees the actual shapes
// instead of opaque pointer strings. Local "#/..." refs resolve against the
// current document; "./openapi.yaml#/..." refs (used by streaming.yaml)
// resolve against the companion OpenAPI document and continue resolving
// there. Cycles collapse to a stable {$cycle} marker.
function resolveRefs(value: unknown, document: JsonObject, external: JsonObject, stack: Set<string> = new Set()): unknown {
  if (Array.isArray(value)) return value.map(item => resolveRefs(item, document, external, stack));
  if (!value || typeof value !== "object") return value;
  const record = value as JsonObject;
  if (typeof record.$ref === "string") {
    const ref = record.$ref;
    let target: unknown;
    let nextDocument = document;
    if (ref.startsWith("#/")) {
      target = pointerTarget(ref.slice(1), document);
    } else if (ref.startsWith("./openapi.yaml#/")) {
      nextDocument = external;
      target = pointerTarget(ref.slice("./openapi.yaml#".length), external);
    } else {
      return { $unresolvedRef: ref };
    }
    const key = `${nextDocument === external ? "openapi" : "self"}:${ref}`;
    if (stack.has(key)) return { $cycle: ref };
    const nested = new Set(stack);
    nested.add(key);
    const resolved = resolveRefs(target, nextDocument, external, nested);
    // OpenAPI 3.1 allows constraints beside $ref (both apply). Merge them
    // over the resolved target so a sibling change — adding maxLength next
    // to an unchanged $ref — is visible to the comparison.
    const { $ref: _ignored, ...siblings } = record;
    if (Object.keys(siblings).length === 0) return resolved;
    const resolvedSiblings = resolveRefs(siblings, document, external, stack) as JsonObject;
    if (resolved && typeof resolved === "object" && !Array.isArray(resolved)) {
      return { ...(resolved as JsonObject), ...resolvedSiblings };
    }
    return resolved;
  }
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(record)) {
    result[key] = resolveRefs(item, document, external, stack);
  }
  return result;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

// Semantic schema comparison over fully resolved, annotation-stripped nodes.
// Conservative fail-closed: only explicitly recognized additive shapes are
// compatible; every unrecognized difference is breaking.
function compareSchemas(label: string, before: unknown, after: unknown, direction: Direction, failures: string[]): void {
  if (stable(before) === stable(after)) return;
  if (Array.isArray(before) || Array.isArray(after) || !before || !after || typeof before !== "object" || typeof after !== "object") {
    failures.push(`${label}: changed`);
    return;
  }
  const b = before as JsonObject;
  const a = after as JsonObject;
  const keywords = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const keyword of keywords) {
    if (stable(b[keyword]) === stable(a[keyword])) continue;
    switch (keyword) {
      case "properties": {
        const beforeProperties = object(b.properties);
        const afterProperties = object(a.properties);
        const afterRequired = new Set(asStringArray(a.required));
        for (const name of Object.keys(beforeProperties)) {
          if (!(name in afterProperties)) {
            failures.push(`${label}: removed property ${name}`);
            continue;
          }
          compareSchemas(`${label}.${name}`, beforeProperties[name], afterProperties[name], direction, failures);
        }
        for (const name of Object.keys(afterProperties)) {
          if (name in beforeProperties) continue;
          if (afterRequired.has(name)) continue; // reported by the required case below
          if (direction === "response" && b.additionalProperties === false) {
            failures.push(`${label}: added property ${name} to a closed response object (old validators reject it)`);
          }
        }
        break;
      }
      case "required": {
        const beforeRequired = new Set(asStringArray(b.required));
        const afterRequired = new Set(asStringArray(a.required));
        for (const name of afterRequired) {
          if (!beforeRequired.has(name) && direction === "request") failures.push(`${label}: property ${name} became required`);
          if (!beforeRequired.has(name) && direction === "response" && !(name in object(b.properties))) {
            failures.push(`${label}: added required property ${name}`);
          }
        }
        for (const name of beforeRequired) {
          if (!afterRequired.has(name) && direction === "response") failures.push(`${label}: property ${name} is no longer guaranteed (required removed)`);
        }
        break;
      }
      case "enum": {
        const beforeValues = new Set((Array.isArray(b.enum) ? b.enum : []).map(stable));
        const afterValues = new Set((Array.isArray(a.enum) ? a.enum : []).map(stable));
        const added = [...afterValues].filter(item => !beforeValues.has(item));
        const removed = [...beforeValues].filter(item => !afterValues.has(item));
        if (direction === "request" && removed.length > 0) failures.push(`${label}: enum no longer accepts ${removed.join(", ")}`);
        if (direction === "response" && added.length > 0) failures.push(`${label}: enum gained values old clients do not know: ${added.join(", ")}`);
        break;
      }
      case "items": {
        compareSchemas(`${label}.items`, b.items, a.items, direction, failures);
        break;
      }
      case "oneOf":
      case "anyOf":
      case "allOf": {
        const beforeBranches = Array.isArray(b[keyword]) ? b[keyword] as unknown[] : [];
        const afterBranches = Array.isArray(a[keyword]) ? a[keyword] as unknown[] : [];
        if (beforeBranches.length !== afterBranches.length) {
          failures.push(`${label}: ${keyword} branch count changed`);
          break;
        }
        beforeBranches.forEach((branch, index) => compareSchemas(`${label}.${keyword}[${index}]`, branch, afterBranches[index], direction, failures));
        break;
      }
      default:
        failures.push(`${label}: changed ${keyword}`);
    }
  }
}

function compareOperation(name: string, before: JsonObject, after: JsonObject, baseDocument: JsonObject, proposedDocument: JsonObject): string[] {
  const failures: string[] = [];
  const resolveBase = (value: unknown) => stripAnnotations(resolveRefs(value, baseDocument, {}));
  const resolveProposed = (value: unknown) => stripAnnotations(resolveRefs(value, proposedDocument, {}));
  const beforeResponses = object(resolveBase(before.responses));
  const afterResponses = object(resolveProposed(after.responses));
  for (const status of Object.keys(beforeResponses)) {
    if (!(status in afterResponses)) failures.push(`${name}: removed response ${status}`);
  }
  const beforeParameters = (Array.isArray(before.parameters) ? before.parameters : []).map(item => object(resolveBase(item)));
  const afterParameters = (Array.isArray(after.parameters) ? after.parameters : []).map(item => object(resolveProposed(item)));
  for (const parameter of afterParameters) {
    if (parameter.required !== true) continue;
    const existed = beforeParameters.some(candidate => candidate.name === parameter.name && candidate.in === parameter.in);
    if (!existed) failures.push(`${name}: added required ${String(parameter.in)} parameter ${String(parameter.name)}`);
  }
  for (const parameter of beforeParameters) {
    const next = afterParameters.find(candidate => candidate.name === parameter.name && candidate.in === parameter.in);
    if (!next) {
      failures.push(`${name}: removed ${String(parameter.in)} parameter ${String(parameter.name)}`);
      continue;
    }
    if (parameter.required !== true && next.required === true) {
      failures.push(`${name}: made ${String(parameter.in)} parameter ${String(parameter.name)} required`);
    }
    // Serialization keywords change the wire encoding (repeated keys vs a
    // comma-joined value, reserved-character escaping) even when the schema
    // is untouched — generated clients keep emitting the old format.
    for (const keyword of ["style", "explode", "allowReserved"] as const) {
      if (stable(parameter[keyword]) !== stable(next[keyword])) {
        failures.push(`${name}: changed ${String(parameter.in)} parameter ${String(parameter.name)} ${keyword}`);
      }
    }
    compareSchemas(`${name}: ${String(parameter.in)} parameter ${String(parameter.name)} schema`, parameter.schema, next.schema, "request", failures);
  }
  if (!before.requestBody && object(after.requestBody).required === true) failures.push(`${name}: added required request body`);
  if (before.requestBody && object(before.requestBody).required !== true && object(after.requestBody).required === true) {
    failures.push(`${name}: made request body required`);
  }
  const beforeRequestContent = object(object(resolveBase(before.requestBody)).content);
  const afterRequestContent = object(object(resolveProposed(after.requestBody)).content);
  for (const media of Object.keys(beforeRequestContent)) {
    if (!(media in afterRequestContent)) {
      failures.push(`${name}: removed request media type ${media}`);
      continue;
    }
    compareSchemas(`${name}: request schema for ${media}`, object(beforeRequestContent[media]).schema, object(afterRequestContent[media]).schema, "request", failures);
  }
  for (const [status, response] of Object.entries(beforeResponses)) {
    if (!(status in afterResponses)) continue;
    const afterResponse = object(afterResponses[status]);
    const beforeContent = object(object(response).content);
    const afterContent = object(afterResponse.content);
    for (const media of Object.keys(beforeContent)) {
      if (!(media in afterContent)) {
        failures.push(`${name}: removed response ${status} media type ${media}`);
        continue;
      }
      compareSchemas(`${name}: response ${status} schema for ${media}`, object(beforeContent[media]).schema, object(afterContent[media]).schema, "response", failures);
    }
    // Documented response headers are part of the wire contract: removing
    // one or changing its schema breaks clients that read it.
    const beforeHeaders = object(object(response).headers);
    const afterHeaders = object(afterResponse.headers);
    for (const [header, headerValue] of Object.entries(beforeHeaders)) {
      if (!(header in afterHeaders)) {
        failures.push(`${name}: removed response ${status} header ${header}`);
        continue;
      }
      compareSchemas(`${name}: response ${status} header ${header} schema`, object(headerValue).schema, object(afterHeaders[header]).schema, "response", failures);
    }
  }
  if (stable(before.security) !== stable(after.security)) failures.push(`${name}: changed authentication requirements`);
  return failures;
}

// A change to a security scheme *definition* (cookie name, scheme type) is a
// wire break for every operation whose effective security references it,
// even though requirement arrays only name schemes and never $ref them.
function compareSecuritySchemes(base: JsonObject, proposed: JsonObject, baseOperations: Map<string, { domain: ApiDomain; value: JsonObject }>): CompatibilityResult {
  const breaking: Record<ApiDomain, string[]> = { hub: [], workspace: [] };
  const changed = new Set<ApiDomain>();
  const baseSchemes = object(object(base.components).securitySchemes);
  const proposedSchemes = object(object(proposed.components).securitySchemes);
  const domainsReferencing = (scheme: string): ApiDomain[] => {
    const domains = new Set<ApiDomain>();
    for (const { domain, value } of baseOperations.values()) {
      const requirements = Array.isArray(value.security) ? value.security : [];
      if (requirements.some(requirement => scheme in object(requirement))) domains.add(domain);
    }
    return [...domains];
  };
  for (const [scheme, definition] of Object.entries(baseSchemes)) {
    const affected = domainsReferencing(scheme);
    if (!(scheme in proposedSchemes)) {
      for (const domain of affected) {
        changed.add(domain);
        breaking[domain].push(`security scheme ${scheme}: removed`);
      }
      continue;
    }
    if (stable(stripAnnotations(definition)) !== stable(stripAnnotations(proposedSchemes[scheme]))) {
      for (const domain of affected) {
        changed.add(domain);
        breaking[domain].push(`security scheme ${scheme}: definition changed`);
      }
    }
  }
  return { changedDomains: [...changed].sort(), breaking };
}

export function compareContracts(base: JsonObject, proposed: JsonObject): CompatibilityResult {
  const baseOperations = operations(base);
  const proposedOperations = operations(proposed);
  const changed = new Set<ApiDomain>();
  const breaking: Record<ApiDomain, string[]> = { hub: [], workspace: [] };
  for (const [name, prior] of baseOperations) {
    const next = proposedOperations.get(name);
    if (!next) {
      changed.add(prior.domain);
      breaking[prior.domain].push(`${name}: operation removed`);
      continue;
    }
    const operationChanged = stable(prior.value) !== stable(next.value);
    const resolvedChanged = stable(resolveRefs(prior.value, base, {})) !== stable(resolveRefs(next.value, proposed, {}));
    if (operationChanged || resolvedChanged) changed.add(prior.domain);
    breaking[prior.domain].push(...compareOperation(name, prior.value, next.value, base, proposed));
  }
  for (const [name, next] of proposedOperations) {
    if (!baseOperations.has(name)) changed.add(next.domain);
  }
  const schemes = compareSecuritySchemes(base, proposed, baseOperations);
  return mergeCompatibilityResults({ changedDomains: [...changed].sort(), breaking }, schemes);
}

function streamingChannelDomain(channel: JsonObject): ApiDomain {
  return String(channel.path ?? "").startsWith("/s/") ? "workspace" : "hub";
}

// Schema names a channel references, keyed by wire direction. Channels name
// schemas as plain strings (dataSchema/itemSchema/frames), and the bodies
// live in the document's top-level schemas block.
function channelSchemaDirections(channel: JsonObject): Map<string, Direction> {
  const result = new Map<string, Direction>();
  const note = (value: unknown, direction: Direction) => {
    if (typeof value === "string") {
      // A schema referenced in both directions keeps "response": strict old
      // validators make it the more conservative side for every rule.
      result.set(value, result.get(value) === "response" ? "response" : direction);
    }
  };
  const frames = (framesValue: unknown, direction: Direction) => {
    const framesObject = object(framesValue);
    note(object(framesObject.binary).schema, direction);
    for (const schema of asStringArray(object(framesObject.textJson).schemas)) note(schema, direction);
  };
  for (const event of Array.isArray(channel.events) ? channel.events : []) note(object(event).dataSchema, "response");
  note(channel.itemSchema, "response");
  frames(channel.clientFrames, "request");
  frames(channel.serverFrames, "response");
  return result;
}

export function compareStreamingContracts(base: JsonObject, proposed: JsonObject, baseOpenapi: JsonObject = {}, proposedOpenapi: JsonObject = {}): CompatibilityResult {
  const breaking: Record<ApiDomain, string[]> = { hub: [], workspace: [] };
  const changed = new Set<ApiDomain>();
  const baseSchemas = object(base.schemas);
  const proposedSchemas = object(proposed.schemas);
  const resolveSchema = (name: string, document: JsonObject, schemas: JsonObject, openapi: JsonObject): unknown =>
    name in schemas ? stripAnnotations(resolveRefs(schemas[name], document, openapi)) : undefined;
  for (const [name, value] of Object.entries(object(base.channels))) {
    const channel = object(value);
    const domain = streamingChannelDomain(channel);
    const next = object(base.channels && object(proposed.channels)[name]);
    if (!(name in object(proposed.channels))) {
      changed.add(domain);
      breaking[domain].push(`streaming channel ${name}: removed`);
      continue;
    }
    if (stable(stripAnnotations(channel)) !== stable(stripAnnotations(next))) {
      changed.add(domain);
      breaking[domain].push(`streaming channel ${name}: existing protocol changed`);
    } else if (stable(channel) !== stable(next)) {
      changed.add(domain);
    }
    // The channel body only names its schemas — compare the referenced
    // schema bodies too, or a wire break in the schemas block ships unseen.
    for (const [schemaName, direction] of channelSchemaDirections(channel)) {
      const before = resolveSchema(schemaName, base, baseSchemas, baseOpenapi);
      const after = resolveSchema(schemaName, proposed, proposedSchemas, proposedOpenapi);
      if (before === undefined) continue;
      if (after === undefined) {
        changed.add(domain);
        breaking[domain].push(`streaming channel ${name}: schema ${schemaName} removed`);
        continue;
      }
      const failures: string[] = [];
      compareSchemas(`streaming channel ${name}: schema ${schemaName}`, before, after, direction, failures);
      if (failures.length > 0) {
        changed.add(domain);
        breaking[domain].push(...failures);
      } else if (stable(resolveRefs(baseSchemas[schemaName], base, baseOpenapi)) !== stable(resolveRefs(proposedSchemas[schemaName], proposed, proposedOpenapi))) {
        changed.add(domain);
      }
    }
  }
  for (const [name, value] of Object.entries(object(proposed.channels))) {
    if (name in object(base.channels)) continue;
    changed.add(streamingChannelDomain(object(value)));
  }
  return { changedDomains: [...changed].sort(), breaking };
}

type InventoryOperation = JsonObject & { operationId?: unknown; domain?: unknown };

// Fields of an inventory entry that describe the wire contract itself;
// mutating any of them for an existing operation is a break.
const INVENTORY_WIRE_FIELDS = ["method", "path", "childPath", "transport", "auth"] as const;
const INVENTORY_SET_FIELDS = ["statuses", "requestMediaTypes", "responseMediaTypes"] as const;

export function compareInventories(base: JsonObject, proposed: JsonObject): CompatibilityResult {
  const breaking: Record<ApiDomain, string[]> = { hub: [], workspace: [] };
  const changed = new Set<ApiDomain>();
  const entryDomain = (entry: InventoryOperation): ApiDomain => (entry.domain === "workspace" ? "workspace" : "hub");
  const index = (document: JsonObject): Map<string, InventoryOperation> => {
    const result = new Map<string, InventoryOperation>();
    for (const entry of Array.isArray(document.operations) ? document.operations : []) {
      const record = object(entry) as InventoryOperation;
      if (typeof record.operationId === "string") result.set(record.operationId, record);
    }
    return result;
  };
  const baseIndex = index(base);
  const proposedIndex = index(proposed);
  for (const [id, entry] of baseIndex) {
    const domain = entryDomain(entry);
    const next = proposedIndex.get(id);
    if (!next) {
      changed.add(domain);
      breaking[domain].push(`inventory: removed operation ${id}`);
      continue;
    }
    for (const field of INVENTORY_WIRE_FIELDS) {
      if (stable(entry[field]) !== stable(next[field])) {
        changed.add(domain);
        breaking[domain].push(`inventory: operation ${id} changed ${field}`);
      }
    }
    for (const field of INVENTORY_SET_FIELDS) {
      const before = new Set((Array.isArray(entry[field]) ? entry[field] as unknown[] : []).map(stable));
      const after = new Set((Array.isArray(next[field]) ? next[field] as unknown[] : []).map(stable));
      const removed = [...before].filter(item => !after.has(item));
      if (removed.length > 0) {
        changed.add(domain);
        breaking[domain].push(`inventory: operation ${id} removed ${field} entries ${removed.join(", ")}`);
      } else if ([...after].some(item => !before.has(item))) {
        changed.add(domain);
      }
    }
    if (stable(entry) !== stable(next)) changed.add(domain);
  }
  for (const [id, entry] of proposedIndex) {
    if (!baseIndex.has(id)) changed.add(entryDomain(entry));
  }
  return { changedDomains: [...changed].sort(), breaking };
}

// Exclusions are classification, not wire shape: adding, removing, or
// rewording one marks the affected domain changed but is never breaking on
// its own (promoting an excluded route to public shows up in the contract
// comparison instead).
export function compareExclusions(base: JsonObject, proposed: JsonObject): CompatibilityResult {
  const changed = new Set<ApiDomain>();
  const scopeDomains = (scope: unknown): ApiDomain[] => {
    if (scope === "hub") return ["hub"];
    if (scope === "workspace") return ["workspace"];
    if (scope === "test") return [];
    return ["hub", "workspace"];
  };
  const index = (document: JsonObject): Map<string, JsonObject> => {
    const result = new Map<string, JsonObject>();
    for (const entry of Array.isArray(document.exclusions) ? document.exclusions : []) {
      const record = object(entry);
      if (typeof record.id === "string") result.set(record.id, record);
    }
    return result;
  };
  const baseIndex = index(base);
  const proposedIndex = index(proposed);
  for (const [id, entry] of baseIndex) {
    const next = proposedIndex.get(id);
    if (!next || stable(entry) !== stable(next)) scopeDomains(entry.scope).forEach(domain => changed.add(domain));
  }
  for (const [id, entry] of proposedIndex) {
    if (!baseIndex.has(id)) scopeDomains(entry.scope).forEach(domain => changed.add(domain));
  }
  return { changedDomains: [...changed].sort(), breaking: { hub: [], workspace: [] } };
}

export function mergeCompatibilityResults(...results: CompatibilityResult[]): CompatibilityResult {
  return {
    changedDomains: [...new Set(results.flatMap(result => result.changedDomains))].sort() as ApiDomain[],
    breaking: {
      hub: results.flatMap(result => result.breaking.hub),
      workspace: results.flatMap(result => result.breaking.workspace),
    },
  };
}

export function revisions(metadata: JsonObject): Record<ApiDomain, number> {
  const revisionObject = object(metadata.revisions);
  const hub = metadata.hubApiRevision ?? revisionObject.hub;
  const workspace = metadata.workspaceApiRevision ?? revisionObject.workspace;
  if (!Number.isInteger(hub) || !Number.isInteger(workspace)) {
    throw new Error("contract metadata must contain integer hubApiRevision and workspaceApiRevision values");
  }
  return { hub: hub as number, workspace: workspace as number };
}

export function assertCompatibilityPolicy(
  result: CompatibilityResult,
  baseMetadata: JsonObject,
  proposedMetadata: JsonObject,
  changelog: string,
): void {
  const base = revisions(baseMetadata);
  const proposed = revisions(proposedMetadata);
  const failures: string[] = [];
  const entryHeader = `## Hub ${proposed.hub} / Workspace ${proposed.workspace}`;
  const entryStart = changelog.indexOf(entryHeader);
  const entryEnd = entryStart < 0 ? -1 : changelog.indexOf("\n## ", entryStart + entryHeader.length);
  const entry = entryStart < 0 ? "" : changelog.slice(entryStart, entryEnd < 0 ? undefined : entryEnd);
  const migrationMatch = /(?:^|\n)### Migration\s*\n([\s\S]*?)(?=\n### |$)/i.exec(entry);
  const migrationText = migrationMatch?.[1]?.trim() ?? "";
  for (const domain of ["hub", "workspace"] as const) {
    if (proposed[domain] < base[domain]) failures.push(`${domain}: revision decreased from ${base[domain]} to ${proposed[domain]}`);
    if (result.breaking[domain].length === 0) continue;
    if (proposed[domain] <= base[domain]) failures.push(`${domain}: breaking change requires a revision greater than ${base[domain]}`);
    const migration = migrationText !== ""
      && !/^none\b/i.test(migrationText)
      && new RegExp(`\\b${domain}\\b`, "i").test(migrationText);
    if (!migration) failures.push(`${domain}: breaking change requires changelog migration guidance naming the domain`);
  }
  if (failures.length > 0) {
    const details = (["hub", "workspace"] as const).flatMap(domain => result.breaking[domain]);
    throw new Error(["API compatibility policy failed:", ...failures.map(item => `- ${item}`), ...details.map(item => `  ${item}`)].join("\n"));
  }
}

export async function readYaml(path: string): Promise<JsonObject> {
  return object(parseYaml(await readFile(path, "utf8")));
}

if (import.meta.main) {
  const values = Object.fromEntries(process.argv.slice(2).map(argument => {
    const [name, ...rest] = argument.replace(/^--/, "").split("=");
    return [name, rest.join("=")];
  }));
  for (const required of ["base-contract", "base-streaming", "base-metadata", "contract", "streaming", "metadata", "changelog"]) {
    if (!values[required]) throw new Error(`missing --${required}=PATH`);
  }
  const baseContract = await readYaml(values["base-contract"]);
  const proposedContract = await readYaml(values.contract);
  const results = [
    compareContracts(baseContract, proposedContract),
    compareStreamingContracts(await readYaml(values["base-streaming"]), await readYaml(values.streaming), baseContract, proposedContract),
  ];
  // Inventory and exclusions are published artifacts too; their base files
  // are optional so contract initialization stays a clean first publication.
  if (values["base-operations"]) {
    results.push(compareInventories(await readYaml(values["base-operations"]), await readYaml(values.operations ?? "api/operations.yaml")));
  }
  if (values["base-exclusions"]) {
    results.push(compareExclusions(await readYaml(values["base-exclusions"]), await readYaml(values.exclusions ?? "api/exclusions.yaml")));
  }
  const result = mergeCompatibilityResults(...results);
  assertCompatibilityPolicy(
    result,
    await readYaml(values["base-metadata"]),
    await readYaml(values.metadata),
    await readFile(values.changelog, "utf8"),
  );
  console.log(`API compatibility passed; changed domains: ${result.changedDomains.join(", ") || "none"}`);
}
