/** Curated review illustrations, not approved pixel goldens or a capture archive. */
export const galleryScenes = [
  ["hub", "Hub overview"],
  ["settings", "Settings overview"],
  ["create-editor", "Create Workspace editor"],
  ["creation-cancel", "Creation Cancel returns to Add Workspace"],
  ["security", "Session Security owns Devices"],
  ["devices", "Device sessions"],
  ["folder-list", "Choose a Hub folder"],
  ["folder-empty", "Folder-only empty state"],
  ["preview-markdown", "Markdown preview with local image"],
  ["preview-siblings", "AsciiDoc preview with sibling navigation"],
] as const;
export const galleryEngines = ["chromium", "webkit"] as const;
export const galleryViewport = { width: 390, height: 844, deviceScaleFactor: 2 } as const;
export const galleryImages = galleryEngines.flatMap(engine => galleryScenes.map(([scene, label]) => ({
  path: `gallery/${engine}-${scene}.png`, engine, scene, label,
})));
