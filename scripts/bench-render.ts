import { promises as fs } from "node:fs";
import path from "node:path";

import { bench, run } from "mitata";
import { parseHTML } from "linkedom";

import { renderDocument, scanRoots, type WatchEntry } from "../src/server";
import type { RootGroup, ViewMode } from "../src/shared";
import { renderDocumentDiff, DIFF_MAX_BYTES } from "../src/document-diff-view";

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

// Diff-view bench scenarios. The Pierre Shadow-DOM render path needs a real
// browser DOM and is exercised via Playwright; here we measure the lightweight
// fallback emitter that drives very-large diffs and the non-git / unchanged /
// binary state cards. Both paths run without invoking @pierre/diffs.
const diffHost = installLinkedomDOM();
const largeDiffPatch = synthesizeLargeDiff();

bench("diff lightweight-fallback large patch", async () => {
  await renderDocumentDiff(
    diffHost,
    {
      kind: "text",
      baseRef: "origin/main",
      patch: largeDiffPatch,
      bytes: largeDiffPatch.length,
      addedLines: 5_000,
      deletedLines: 5_000,
    },
    null,
  );
  if (!diffHost.firstChild) throw new Error("diff fallback produced no output");
});

bench("diff state-card unchanged", async () => {
  await renderDocumentDiff(diffHost, { kind: "unchanged", baseRef: "origin/main" }, null);
});

console.log(`Diff bench context\nlarge_patch_bytes\t${largeDiffPatch.length}\nDIFF_MAX_BYTES\t${DIFF_MAX_BYTES}\n`);

await run();

function installLinkedomDOM(): HTMLElement {
  const { document, window } = parseHTML("<!doctype html><html><body><div id='diff-host'></div></body></html>");
  (globalThis as unknown as { document: unknown }).document = document;
  (globalThis as unknown as { window: unknown }).window = window;
  return document.getElementById("diff-host") as unknown as HTMLElement;
}

function synthesizeLargeDiff(): string {
  // Synthesize a unified diff larger than DIFF_MAX_BYTES so the fallback
  // path triggers. Five thousand added + five thousand deleted lines of
  // realistic-shaped content keeps the bench representative without
  // exploding total runtime.
  const lines: string[] = [
    "diff --git a/synthetic.ts b/synthetic.ts",
    "--- a/synthetic.ts",
    "+++ b/synthetic.ts",
    "@@ -1,5000 +1,5000 @@",
  ];
  for (let i = 0; i < 5_000; i++) {
    lines.push(`-const value${i} = ${i};`);
    lines.push(`+const value${i} = ${i + 1};`);
  }
  return lines.join("\n") + "\n";
}

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
