import { parse } from "yaml";
import openapiSource from "../../../api/openapi.yaml?raw";

export type ApiOperation = {
  id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  tags: string[];
};

const httpMethods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

export function readOperations(source = openapiSource): ApiOperation[] {
  const document = parse(source) as { paths?: Record<string, Record<string, unknown>> };
  const operations: ApiOperation[] = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, candidate] of Object.entries(pathItem ?? {})) {
      if (!httpMethods.has(method.toLowerCase()) || !candidate || typeof candidate !== "object") continue;
      const operation = candidate as Record<string, unknown>;
      if (typeof operation.operationId !== "string") continue;
      operations.push({
        id: operation.operationId,
        method: method.toUpperCase(),
        path,
        summary: typeof operation.summary === "string" ? operation.summary : operation.operationId,
        description: typeof operation.description === "string" ? operation.description : "",
        tags: Array.isArray(operation.tags) ? operation.tags.filter((tag): tag is string => typeof tag === "string") : [],
      });
    }
  }
  return operations.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}
