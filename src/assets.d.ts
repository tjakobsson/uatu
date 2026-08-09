// Bun `with { type: "file" }` imports resolve to the bundled asset's path (a
// string) at runtime. TypeScript cannot model import attributes, so these
// ambient declarations type the file-loader shape for the asset kinds cli.ts
// embeds. Wildcard declarations match the import specifier when normal
// resolution has no types for it.

declare module "*.svg" {
  const path: string;
  export default path;
}

declare module "*.png" {
  const path: string;
  export default path;
}

declare module "*.webmanifest" {
  const path: string;
  export default path;
}

declare module "*.woff2" {
  const path: string;
  export default path;
}

declare module "*.md" {
  const path: string;
  export default path;
}

// Exact specifiers for the two JS files imported as assets — a `*.js`
// wildcard would swallow genuine module imports.
declare module "mermaid/dist/mermaid.min.js" {
  const path: string;
  export default path;
}
