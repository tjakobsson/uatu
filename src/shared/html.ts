// HTML escaping primitives used by every renderer that builds DOM via
// `innerHTML` from server-trusted data. Lives in src/shared/ rather than
// src/app.ts because moving the helpers out of app.ts in section 6 of the
// feature-folder refactor exposed a circular-import hazard: sidebar/panes.ts's
// `renderPanelsMenu` runs at boot (called by `initSidebarPanes()` at module
// load) and was crashing with "Cannot read properties of null (reading
// 'escapeHtmlAttribute')" because the export binding wasn't initialized yet
// in the partial-loaded `../app` namespace.

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}
