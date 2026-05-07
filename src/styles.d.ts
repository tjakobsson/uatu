// Side-effect CSS imports (xterm.css and others). Bun bundles these with the
// HTML shell; TypeScript just needs an ambient declaration so the import
// doesn't error out at type-check time.
declare module "*.css";
