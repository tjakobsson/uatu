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
    walkChildren(node as Element);
    return;
  }
  if (node.type === "root") {
    walkChildren(node as Root);
  }
}

function walkChildren(parent: Parent): void {
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

// Resolves relative `href`s and `src`s against `baseUrl`, after sanitizing
// (so only URLs the schema already allowed are touched). In-page fragments
// (`#heading`) stay as they are. A result that isn't http(s) is dropped.
export function resolveRelativeUrls(tree: Nodes, baseUrl: string): void {
  const visit = (node: Nodes | RootContent | ElementContent): void => {
    if (node.type === "element") {
      const element = node as Element;
      const attribute = element.tagName === "a" ? "href" : element.tagName === "img" ? "src" : null;
      const value = attribute ? element.properties?.[attribute] : undefined;
      // Only relative values: an absolute one already passed the schema's
      // protocol allowlist.
      if (attribute && typeof value === "string" && value !== "" && !value.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(value)) {
        let absolute: URL | null = null;
        try {
          absolute = new URL(value, baseUrl);
        } catch {
          absolute = null;
        }
        if (absolute && (absolute.protocol === "https:" || absolute.protocol === "http:")) element.properties![attribute] = absolute.href;
        else delete element.properties![attribute];
      }
      visitChildren(element, visit);
      return;
    }
    if (node.type === "root") visitChildren(node as Root, visit);
  };
  visit(tree);
}

function visitChildren(parent: Parent, visit: (node: RootContent | ElementContent) => void): void {
  for (const child of parent.children) visit(child);
}
