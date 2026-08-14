import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected an object`);
  return value as JsonObject;
}

export async function validateStructural(root = "api"): Promise<void> {
  const openApi = object(parseYaml(await readFile(path.join(root, "openapi.yaml"), "utf8")), "openapi.yaml");
  const streaming = object(parseYaml(await readFile(path.join(root, "streaming.yaml"), "utf8")), "streaming.yaml");
  const metadata = object(JSON.parse(await readFile(path.join(root, "contract.json"), "utf8")), "contract.json");
  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  if (openApi.openapi !== "3.1.0") throw new Error(`openapi.yaml: expected OpenAPI 3.1.0, got ${String(openApi.openapi)}`);
  object(openApi.paths, "openapi.yaml paths");
  if (!streaming.asyncapi && !streaming.channels && !streaming.protocols) {
    throw new Error("streaming.yaml: expected machine-readable channels or protocols");
  }
  for (const field of ["hubApiRevision", "workspaceApiRevision"]) {
    if (!Number.isInteger(metadata[field])) throw new Error(`contract.json: ${field} must be an integer`);
  }
  if (!/^## /m.test(changelog)) throw new Error("CHANGELOG.md: expected at least one structured level-two entry");
  const operationIds = new Set<string>();
  for (const [route, pathItem] of Object.entries(object(openApi.paths, "openapi.yaml paths"))) {
    for (const [method, operationValue] of Object.entries(object(pathItem, route))) {
      if (!new Set(["get", "post", "put", "patch", "delete", "head", "options"]).has(method)) continue;
      const operation = object(operationValue, `${method.toUpperCase()} ${route}`);
      if (typeof operation.operationId !== "string" || operation.operationId === "") {
        throw new Error(`${method.toUpperCase()} ${route}: missing operationId`);
      }
      if (operationIds.has(operation.operationId)) throw new Error(`${operation.operationId}: duplicate operationId`);
      operationIds.add(operation.operationId);
      object(operation.responses, `${operation.operationId} responses`);
    }
  }
  console.log(`Contract structure passed: ${operationIds.size} HTTP operations`);
}

if (import.meta.main) await validateStructural(process.argv[2] ?? "api");
