import { promises as fs } from "node:fs";
import path from "node:path";

import { bench, run } from "mitata";

import { renderDocument, scanRoots, type WatchEntry } from "../src/server";
import type { RootGroup, ViewMode } from "../src/shared";

type RenderScenario = {
  name: string;
  relativePath: string;
  view: ViewMode;
};

type ScenarioContext = RenderScenario & {
  sourceBytes: number;
  outputBytes: number;
};

const fixtureRoot = path.resolve(import.meta.dir, "../testdata/render-benchmarks");

const scenarios: RenderScenario[] = [
  { name: "markdown-large rendered", relativePath: "markdown-large.md", view: "rendered" },
  { name: "markdown-large source", relativePath: "markdown-large.md", view: "source" },
  { name: "asciidoc-architecture-large rendered", relativePath: "architecture-large.adoc", view: "rendered" },
  { name: "asciidoc-architecture-large source", relativePath: "architecture-large.adoc", view: "source" },
  { name: "source-large source", relativePath: "source-large.ts", view: "source" },
];

const entries: WatchEntry[] = [{ kind: "dir", absolutePath: fixtureRoot }];
const roots = await scanRoots(entries, { respectGitignore: false });
const contexts = await collectScenarioContext(roots);

printScenarioContext(contexts);

for (const scenario of scenarios) {
  const documentId = findDocumentId(roots, scenario.relativePath);
  bench(scenario.name, async () => {
    const rendered = await renderDocument(roots, documentId, { view: scenario.view });
    if (rendered.html.length === 0) {
      throw new Error(`empty render output for ${scenario.name}`);
    }
  });
}

await run();

async function collectScenarioContext(roots: RootGroup[]): Promise<ScenarioContext[]> {
  const contexts: ScenarioContext[] = [];
  const encoder = new TextEncoder();

  for (const scenario of scenarios) {
    const documentId = findDocumentId(roots, scenario.relativePath);
    const sourceStat = await fs.stat(documentId);
    const rendered = await renderDocument(roots, documentId, { view: scenario.view });
    if (rendered.html.length === 0) {
      throw new Error(`empty render output for ${scenario.name}`);
    }
    contexts.push({
      ...scenario,
      sourceBytes: sourceStat.size,
      outputBytes: encoder.encode(rendered.html).byteLength,
    });
  }

  return contexts;
}

function findDocumentId(roots: RootGroup[], relativePath: string): string {
  for (const root of roots) {
    const document = root.docs.find(candidate => candidate.relativePath === relativePath);
    if (document) {
      return document.id;
    }
  }

  throw new Error(`benchmark fixture not indexed: ${relativePath}`);
}

function printScenarioContext(contexts: ScenarioContext[]): void {
  console.log("Document render benchmark context");
  console.log("scenario\tsource_bytes\toutput_bytes");
  for (const context of contexts) {
    console.log(`${context.name}\t${context.sourceBytes}\t${context.outputBytes}`);
  }
  console.log("");
}
