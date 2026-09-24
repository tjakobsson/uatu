/**
 * The hand-kept half of the agent coverage report (`bun run coverage:agents`,
 * docs/agents/). Everything else in the report is observed by running the
 * normalizers and renderers; these say only what code cannot: why a type is
 * deliberately dropped, and which entries render but do not work.
 *
 * Keys name entries exactly as the report lists them. The generator rejects a
 * key the installed SDK does not declare, so an annotation cannot outlive the
 * vocabulary it describes.
 */
export type CoverageAnnotations = {
  // Why an ignored entry is dropped on purpose; every ignored entry needs
  // one. A key ending in `*` covers every ignored entry under the prefix.
  reasons: Readonly<Record<string, string>>;
  // Entries that render but whose effect the workspace does not deliver:
  // what does not work, and the change or issue that fixes it, by name. No
  // links — tracking artifacts move when they are archived.
  behaviorMissing: Readonly<Record<string, string>>;
};
