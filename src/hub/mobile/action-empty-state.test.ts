import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { action, emptyState } from "./design-system";

test("command hierarchy is explicit, not selection, with a secondary default", () => {
  const { document } = parseHTML(action("create", "Create", "primary") + action("browse", "Browse") + action("remove", "Remove", "destructive"));
  expect(document.querySelectorAll(".mh-commit")).toHaveLength(1);
  expect(document.querySelectorAll(".mh-destructive")).toHaveLength(1);
  expect(document.querySelector('[data-flow="browse"]')?.className).toBe("mh-text-action");
  expect(document.querySelector("[aria-pressed], [aria-selected]")).toBeNull();
});

test("empty composition escapes copy and has no invented action or live error role", () => {
  const { document } = parseHTML(emptyState("folder", "No <subfolders>", "Files aren’t shown here."));
  expect(document.querySelector("h2")?.textContent).toBe("No <subfolders>");
  expect(document.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  expect(document.querySelector("button, [role=alert], [role=status], subfolders")).toBeNull();
});

test("scoped command states retain targets, visible focus, and genuine fills", async () => {
  const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
  expect(css).toContain("min-height: var(--mh-target)");
  expect(css).toContain(".mh-root :focus-visible");
  expect(css).toContain(":not(:disabled):active");
  expect(css).toContain(".mh-root button:disabled");
  expect(css).toContain(".mh-root .mh-commit { background: var(--mh-action-fill); color: var(--mh-on-action)");
  expect(css).toContain(".mh-root .mh-text-action.mh-destructive");
});
