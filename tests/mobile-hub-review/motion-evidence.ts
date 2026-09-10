import { writeFile } from "node:fs/promises";
import type { TestInfo } from "@playwright/test";

/** Explicit opt-in captures in a new evidence directory, never approved goldens. */
export async function recordMotionEvidence(info: TestInfo, name: "geometry" | "handle" | "handle-default" | "handle-default-image" | "handle-saved-left" | "handle-saved-right" | "scroll" | "in-flight", value: object | Uint8Array) {
  if (process.env.UATU_MOTION_EVIDENCE !== "1" || !["chromium", "webkit"].includes(info.project.name)) return;
  const image = value instanceof Uint8Array;
  const destination = new URL(`../../openspec/changes/restore-refined-mobile-hub-experience/review-evidence/motion/${info.project.name}-${name}.${image ? "png" : "json"}`, import.meta.url);
  await writeFile(destination, image ? value : JSON.stringify({ backend: "synthetic", browser: info.project.name, ...value }, null, 2) + "\n");
}
