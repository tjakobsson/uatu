// Mark external (http/https, absolute) anchors with `target="_blank"` and
// `rel="noopener noreferrer"` so following them opens a new browser tab
// instead of unloading the SPA. Same-origin relative hrefs (`other.adoc`,
// `guides/setup.md`, `#section`) and non-http schemes (`mailto:`, `tel:`,
// etc.) are left untouched — the existing in-app anchor handlers manage
// the first group, and the user's intent for the second is platform-defined.
//
// Runs between `sanitize` and `toHtml`. The `target` we set here doesn't
// need the sanitize allowlist to permit `target` — we set the property
// directly on the post-sanitize tree. We do not allow author-supplied
// `target` to survive sanitize, because a `target="_parent"` on an
// internal-link `<a href="other.md">` would cause the cross-doc handler
// to bail and tear down the SPA. `rel` is allowlisted at the call sites
// because author-supplied tokens like `nofollow` / `next` have legitimate
// semantic uses; `mergeRel` deduplicates so our `noopener noreferrer`
// stack regardless.

import type { Element, ElementContent, Nodes, Parent, Root, RootContent } from "hast";

const REQUIRED_REL_TOKENS = ["noopener", "noreferrer"] as const;

export function markExternalAnchors(tree: Nodes): void {
  walk(tree);
}

function walk(node: Nodes | RootContent | ElementContent): void {
  if (node.type === "element") {
    if ((node as Element).tagName === "a") {
      markIfExternal(node as Element);
    }
    visitChildren(node as Element);
    return;
  }
  if (node.type === "root") {
    visitChildren(node as Root);
  }
}

function visitChildren(parent: Parent): void {
  for (const child of parent.children) {
    walk(child);
  }
}

function markIfExternal(anchor: Element): void {
  const properties = anchor.properties ?? {};
  const hrefRaw = properties.href;
  if (typeof hrefRaw !== "string" || hrefRaw === "") {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(hrefRaw);
  } catch {
    // Relative or otherwise non-absolute — the `URL` constructor needs a base
    // to parse those, which would require knowing the document's URL. Bare
    // relative hrefs like `other.adoc` reach this branch and stay untouched.
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return;
  }

  properties.target = "_blank";
  properties.rel = mergeRel(properties.rel);
  anchor.properties = properties;
}

function mergeRel(existing: unknown): string[] {
  const existingTokens = toRelTokens(existing);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const token of [...existingTokens, ...REQUIRED_REL_TOKENS]) {
    const lowered = token.toLowerCase();
    if (seen.has(lowered)) {
      continue;
    }
    seen.add(lowered);
    result.push(token);
  }
  return result;
}

function toRelTokens(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
  }
  if (typeof value === "string") {
    return value.split(/\s+/).filter(token => token !== "");
  }
  return [];
}
