import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

type JsonObject = Record<string, unknown>;
export type ApiDomain = "hub" | "workspace";
export type CompatibilityResult = {
  changedDomains: ApiDomain[];
  breaking: Record<ApiDomain, string[]>;
};

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

function referencedContract(operation: JsonObject, document: JsonObject): string {
  const seen = new Set<string>();
  const values: unknown[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as JsonObject;
    if (typeof record.$ref === "string" && record.$ref.startsWith("#/")) {
      if (seen.has(record.$ref)) return;
      seen.add(record.$ref);
      const target = record.$ref.slice(2).split("/").reduce<unknown>((node, segment) =>
        object(node)[segment.replaceAll("~1", "/").replaceAll("~0", "~")], document);
      values.push([record.$ref, target]);
      visit(target);
    }
    Object.values(record).forEach(visit);
  };
  visit(operation);
  return stable(values);
}

function compareOperation(name: string, before: JsonObject, after: JsonObject): string[] {
  const failures: string[] = [];
  const beforeResponses = object(before.responses);
  const afterResponses = object(after.responses);
  for (const status of Object.keys(beforeResponses)) {
    if (!(status in afterResponses)) failures.push(`${name}: removed response ${status}`);
  }
  const beforeParameters = Array.isArray(before.parameters) ? before.parameters.map(object) : [];
  const afterParameters = Array.isArray(after.parameters) ? after.parameters.map(object) : [];
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
    if (next && parameter.required !== true && next.required === true) {
      failures.push(`${name}: made ${String(parameter.in)} parameter ${String(parameter.name)} required`);
    }
    if (next && stable(parameter.schema) !== stable(next.schema)) {
      failures.push(`${name}: changed ${String(parameter.in)} parameter ${String(parameter.name)} schema`);
    }
  }
  if (!before.requestBody && object(after.requestBody).required === true) failures.push(`${name}: added required request body`);
  if (before.requestBody && object(before.requestBody).required !== true && object(after.requestBody).required === true) {
    failures.push(`${name}: made request body required`);
  }
  const removedMedia = (label: string, beforeContent: unknown, afterContent: unknown) => {
    for (const media of Object.keys(object(beforeContent))) {
      if (!(media in object(afterContent))) failures.push(`${name}: removed ${label} media type ${media}`);
    }
  };
  removedMedia("request", object(before.requestBody).content, object(after.requestBody).content);
  const beforeRequestContent = object(object(before.requestBody).content);
  const afterRequestContent = object(object(after.requestBody).content);
  for (const media of Object.keys(beforeRequestContent)) {
    if (!(media in afterRequestContent)) continue;
    const beforeSchema = object(beforeRequestContent[media]).schema;
    const afterSchema = object(afterRequestContent[media]).schema;
    if (stable(beforeSchema) !== stable(afterSchema)) failures.push(`${name}: changed request schema for ${media}`);
  }
  for (const [status, response] of Object.entries(beforeResponses)) {
    if (!(status in afterResponses)) continue;
    removedMedia(`response ${status}`, object(response).content, object(afterResponses[status]).content);
    const beforeContent = object(object(response).content);
    const afterContent = object(object(afterResponses[status]).content);
    for (const media of Object.keys(beforeContent)) {
      if (!(media in afterContent)) continue;
      const beforeSchema = object(beforeContent[media]).schema;
      const afterSchema = object(afterContent[media]).schema;
      if (stable(beforeSchema) !== stable(afterSchema)) failures.push(`${name}: changed response ${status} schema for ${media}`);
    }
  }
  if (stable(before.security) !== stable(after.security)) failures.push(`${name}: changed authentication requirements`);
  return failures;
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
    const referencedChanged = referencedContract(prior.value, base) !== referencedContract(next.value, proposed);
    if (operationChanged || referencedChanged) changed.add(prior.domain);
    breaking[prior.domain].push(...compareOperation(name, prior.value, next.value));
    if (referencedChanged) {
      breaking[prior.domain].push(`${name}: referenced request or response schema changed; review as incompatible`);
    }
  }
  for (const [name, next] of proposedOperations) {
    if (!baseOperations.has(name)) changed.add(next.domain);
  }
  return { changedDomains: [...changed].sort(), breaking };
}

export function compareStreamingContracts(base: JsonObject, proposed: JsonObject): CompatibilityResult {
  const breaking: Record<ApiDomain, string[]> = { hub: [], workspace: [] };
  const changed = new Set<ApiDomain>();
  const baseChannels = object(base.channels);
  const proposedChannels = object(proposed.channels);
  for (const [name, value] of Object.entries(baseChannels)) {
    const channel = object(value);
    const domain: ApiDomain = String(channel.path ?? "").startsWith("/s/") ? "workspace" : "hub";
    const next = proposedChannels[name];
    if (stable(channel) !== stable(next)) {
      changed.add(domain);
      breaking[domain].push(`streaming channel ${name}: existing protocol changed`);
    }
  }
  for (const [name, value] of Object.entries(proposedChannels)) {
    if (name in baseChannels) continue;
    const domain: ApiDomain = String(object(value).path ?? "").startsWith("/s/") ? "workspace" : "hub";
    changed.add(domain);
  }
  return { changedDomains: [...changed].sort(), breaking };
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
  const result = mergeCompatibilityResults(
    compareContracts(await readYaml(values["base-contract"]), await readYaml(values.contract)),
    compareStreamingContracts(await readYaml(values["base-streaming"]), await readYaml(values.streaming)),
  );
  assertCompatibilityPolicy(
    result,
    await readYaml(values["base-metadata"]),
    await readYaml(values.metadata),
    await readFile(values.changelog, "utf8"),
  );
  console.log(`API compatibility passed; changed domains: ${result.changedDomains.join(", ") || "none"}`);
}
