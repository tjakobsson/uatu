/** Local outline vectors, deliberately independent of workspace icon styling. */
export type MobileHubIcon = "folder" | "branch" | "more" | "plus" | "hub" | "settings" | "key" | "preview" | "device" | "shield" | "back" | "chevron";
const paths: Record<MobileHubIcon, string> = {
  folder: '<path d="M2 5h7l3 4h10v14H2z"/>',
  branch: '<path d="M8 3v14a4 4 0 0 0 8 0V9m0 0-4-4m4 4 4-4"/>',
  more: '<circle cx="12" cy="12" r="10"/><path d="M7 12h.01M12 12h.01M17 12h.01"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  hub: '<path d="M2 2h8v8H2zM14 2h8v8h-8zM2 14h8v8H2zM14 14h8v8h-8z"/>',
  settings: '<path d="m9 2 6 0 1 3 3 2 3 0 1 5-3 2-1 3 0 3-5 2-2-3-3-1-3 0-2-5 3-2 1-3-1-3z"/><circle cx="12" cy="12" r="4"/>',
  key: '<path d="M10 13a5 5 0 1 1 3-4l9 9v4h-4v-3h-3v-3z"/>',
  preview: '<path d="M3 2h18v20H3zM3 7h18M6 4h.01M9 4h.01M7 11h10M7 15h10M7 19h6"/>',
  device: '<path d="M5 2h14v15H5zM5 17l-3 5h20l-3-5"/>',
  shield: '<path d="m12 2 9 4v7c0 5-9 9-9 9s-9-4-9-9V6z"/>',
  back: '<path d="m15 4-8 8 8 8"/>',
  chevron: '<path d="m9 7 5 5-5 5"/>',
};
export function mobileHubIcon(name: MobileHubIcon): string {
  return `<svg class="mh-icon" data-icon="${name}" viewBox="0 0 24 26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
