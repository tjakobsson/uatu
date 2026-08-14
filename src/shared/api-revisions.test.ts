import { describe, expect, test } from "bun:test";
import path from "node:path";
import { parse } from "yaml";

import { HUB_API_REVISION, WORKSPACE_API_REVISION } from "./version";

type RevisionExample = {
  hubApiRevision?: unknown;
  workspaceApiRevision?: unknown;
};

function revisionExamples(value: unknown): RevisionExample[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const current = typeof record.hubApiRevision === "number"
    || typeof record.workspaceApiRevision === "number"
    ? [record]
    : [];
  return current.concat(Object.values(record).flatMap(revisionExamples));
}

describe("public API revision sources", () => {
  test("runtime constants agree with contract metadata", async () => {
    const root = path.resolve(import.meta.dir, "../..");
    const metadata = await Bun.file(path.join(root, "api/contract.json")).json() as RevisionExample;
    expect(metadata.hubApiRevision).toBe(HUB_API_REVISION);
    expect(metadata.workspaceApiRevision).toBe(WORKSPACE_API_REVISION);
  });

  test("runtime constants agree with Hub and workspace OpenAPI examples", async () => {
    const openapiPath = path.resolve(import.meta.dir, "../../api/openapi.yaml");
    expect(await Bun.file(openapiPath).exists()).toBe(true);
    const openapi = parse(await Bun.file(openapiPath).text()) as unknown;
    const examples = revisionExamples(openapi);
    expect(examples.some(example =>
      example.hubApiRevision === HUB_API_REVISION
      && example.workspaceApiRevision === WORKSPACE_API_REVISION
    )).toBe(true);
    expect(examples.some(example =>
      example.workspaceApiRevision === WORKSPACE_API_REVISION
    )).toBe(true);
  });
});
