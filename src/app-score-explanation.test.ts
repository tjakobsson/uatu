import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const APP_TS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "app.ts",
);

// The score-explanation preview MUST be identical across Author and Review
// modes (the spec requires that toggling Mode does not alter score-detail
// preview content). The cheapest way to enforce that is a static-analysis
// regression test: extract the body of buildScoreExplanationHTML and assert
// it does not reference any Mode-aware label or read appState.mode.

async function loadAppSource(): Promise<string> {
  return readFile(APP_TS_PATH, "utf8");
}

function extractFunctionBody(source: string, signature: string): string {
  const startIndex = source.indexOf(signature);
  if (startIndex < 0) {
    throw new Error(`could not find function ${signature} in app.ts`);
  }
  const openBrace = source.indexOf("{", startIndex);
  if (openBrace < 0) {
    throw new Error(`could not find opening brace for ${signature}`);
  }
  // Walk braces to find the matching close. Naive but adequate for our
  // hand-written, well-formatted TS function bodies.
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBrace + 1, index);
      }
    }
  }
  throw new Error(`could not find matching close brace for ${signature}`);
}

describe("buildScoreExplanationHTML is Mode-independent by construction", () => {
  test("function body does not reference appState.mode", async () => {
    const source = await loadAppSource();
    const body = extractFunctionBody(source, "export function buildScoreExplanationHTML(");
    expect(body).not.toContain("appState.mode");
  });

  test("function body does not call the Mode-aware label selector", async () => {
    const source = await loadAppSource();
    const body = extractFunctionBody(source, "export function buildScoreExplanationHTML(");
    expect(body).not.toContain("reviewBurdenHeadlineLabel");
  });

  test("function body does not hardcode either Mode-specific label string", async () => {
    const source = await loadAppSource();
    const body = extractFunctionBody(source, "export function buildScoreExplanationHTML(");
    expect(body).not.toContain("Reviewer burden forecast");
    expect(body).not.toContain("Change review burden");
  });
});
