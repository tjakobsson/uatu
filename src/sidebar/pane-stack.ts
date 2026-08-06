// Pure stack-participation rule for sidebar panes, split from panes.ts so it
// is testable without that module's DOM-at-import dependencies.

// Whether a pane takes part in the stacked height allocation. A pane
// promoted to the phone file-browser overlay (`data-overlay="open"`) is
// position: fixed — allocating stack height to it would both waste space
// and leave a stale inline flex behind on demotion.
export function paneParticipatesInStack(options: {
  visible: boolean;
  collapsed: boolean;
  promoted: boolean;
}): boolean {
  return options.visible && !options.collapsed && !options.promoted;
}
