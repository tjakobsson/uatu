// Pure stack-participation rule for sidebar panes, split from panes.ts so it
// is testable without that module's DOM-at-import dependencies.

// Whether a pane takes part in the stacked height allocation. (The former
// `promoted` exclusion went with the phone file-browser overlay — in touch
// mode the whole stack renders inside the Files tab, so no pane is ever
// position: fixed on its own.)
export function paneParticipatesInStack(options: {
  visible: boolean;
  collapsed: boolean;
}): boolean {
  return options.visible && !options.collapsed;
}
