// Pure (DOM-free) helpers for splitting highlight.js output into per-line
// fragments. Kept separate from `code-block.ts` — which has a module-load DOM
// side effect — so the splitter can be unit-tested without a browser.

// Derive the closing tag for an opening tag string, e.g.
// `<span class="hljs-comment">` -> `</span>`. Assumes well-formed,
// non-self-closing tags, which is what highlight.js emits.
export function closingTagFor(openTag: string): string {
  const name = /^<\s*([a-zA-Z0-9-]+)/.exec(openTag)?.[1] ?? "span";
  return `</${name}>`;
}

// Split a run of highlighted HTML into one self-contained fragment per source
// line. highlight.js tokens can span newlines (block comments, template
// strings, multi-line strings); a naive `split("\n")` would tear those spans
// in half and produce invalid markup. We track the stack of open tags and, at
// each newline, close the still-open tags to finish the line, then reopen them
// at the start of the next line — the standard "reopen spans per line" trick.
//
// The `\n` characters themselves are dropped (they're line delimiters);
// callers re-insert real newline text nodes between lines so the rebuilt
// `<code>` still has `textContent === source`.
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const openTags: string[] = [];
  let current = "";
  // Match either a tag (`<...>`) or a run of non-tag text. This assumes
  // highlight.js output: `<` in content is escaped to `&lt;` (so a literal
  // `<` only ever starts a tag), and `>` never appears inside an attribute
  // value (hljs only emits `class`/`style` on spans). Both hold for hljs but
  // are load-bearing — this would misparse arbitrary HTML silently.
  const token = /(<[^>]+>)|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(html)) !== null) {
    const tag = match[1];
    if (tag !== undefined) {
      current += tag;
      if (/^<\s*\//.test(tag)) {
        openTags.pop();
      } else if (!/\/\s*>$/.test(tag)) {
        openTags.push(tag);
      }
      continue;
    }
    const text = match[2] ?? "";
    const parts = text.split("\n");
    for (let p = 0; p < parts.length; p += 1) {
      current += parts[p];
      if (p < parts.length - 1) {
        // End of a line: close the open tags (reverse order) to balance the
        // fragment, push it, then reopen them for the next line.
        for (let i = openTags.length - 1; i >= 0; i -= 1) {
          current += closingTagFor(openTags[i] as string);
        }
        lines.push(current);
        current = openTags.join("");
      }
    }
  }
  lines.push(current);
  return lines;
}
