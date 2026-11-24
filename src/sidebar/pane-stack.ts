// Pure stack rules for sidebar panes (participation and height allocation),
// split from panes.ts so they are testable without that module's DOM-at-import dependencies.

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

// Every expanded pane keeps its chrome (header, plus any `.pane-toolbar`)
// and this much content below it: about four tree rows on desktop, three
// in touch mode.
export const MIN_PANE_CONTENT_PX = 120;

// Matches `.sidebar-pane { min-height }`: no expanded pane is laid out
// shorter, whatever the allocation says.
export const PANE_FLOOR_PX = 72;

export type PaneHeightRequest = {
  id: string;
  // Stored or measured height the pane would like.
  requested: number;
  // Chrome plus MIN_PANE_CONTENT_PX, or plus the pane's essential content.
  minimum: number;
  // The minimum holds even when the stack is too short for every minimum
  // (the Pull request pane's summary and actions): the other panes share
  // what is left.
  required?: boolean;
};

// Fits the expanded panes into `available` pixels. Every pane gets its
// minimum first; when the requests fit, each gets its request and the grow
// pane takes the spare height; when they do not, the space above the
// minimums is shared in proportion to what each pane asked for beyond its
// own. When even the minimums do not fit, the panes split the space in
// proportion to their minimums, after any `required` pane has its own (short
// of what keeps the others at `floor`). The grow pane absorbs rounding.
export function allocatePaneHeights(
  panes: readonly PaneHeightRequest[],
  available: number,
  growId: string | null,
  // The height no pane goes below (the CSS min-height of a sidebar pane).
  floor = 0,
): Map<string, number> {
  const heights = new Map<string, number>();
  if (panes.length === 0 || available <= 0) return heights;
  const minimumTotal = panes.reduce((sum, pane) => sum + pane.minimum, 0);
  if (minimumTotal >= available) {
    const required = panes.filter(pane => pane.required);
    const shared = panes.filter(pane => !pane.required);
    const requiredTotal = required.reduce((sum, pane) => sum + pane.minimum, 0);
    const sharedTotal = shared.reduce((sum, pane) => sum + pane.minimum, 0);
    // Required panes get their minimum, short of what keeps every other
    // pane at the floor; the others share the rest above the floor in
    // proportion to their minimums.
    const floorTotal = floor * shared.length;
    const requiredSpace = Math.min(requiredTotal, available - floorTotal);
    if (required.length === 0 || shared.length === 0 || requiredSpace <= 0 || sharedTotal <= floorTotal) {
      for (const pane of panes) heights.set(pane.id, Math.floor(available * pane.minimum / minimumTotal));
    } else {
      const spare = available - requiredSpace - floorTotal;
      for (const pane of required) heights.set(pane.id, Math.floor(pane.minimum * requiredSpace / requiredTotal));
      for (const pane of shared) heights.set(pane.id, floor + Math.floor((pane.minimum - floor) * spare / (sharedTotal - floorTotal)));
    }
  } else {
    const wanted = panes.map(pane => ({ ...pane, requested: Math.max(pane.minimum, pane.requested) }));
    const requestedTotal = wanted.reduce((sum, pane) => sum + pane.requested, 0);
    if (requestedTotal <= available) {
      for (const pane of wanted) heights.set(pane.id, pane.requested);
    } else {
      const spare = available - minimumTotal;
      const asked = requestedTotal - minimumTotal;
      for (const pane of wanted) {
        heights.set(pane.id, pane.minimum + Math.floor((pane.requested - pane.minimum) * spare / asked));
      }
    }
  }
  const total = Array.from(heights.values()).reduce((sum, height) => sum + height, 0);
  const absorber = growId && heights.has(growId) ? growId : panes.at(-1)!.id;
  heights.set(absorber, heights.get(absorber)! + available - total);
  return heights;
}

// A pane whose content is rows (the Pull request pane) never ends mid-row at
// its allocated height: how many pixels to give up so the row that straddles
// the visible bottom (`visible`, in the body's content coordinates at scroll
// 0) is hidden whole instead of cut. Rows end where the next begins, so
// trimming to a row's top shows every row above it in full. Zero when no row
// is cut, or when trimming would go below `keep` (the essential content).
export function wholeRowTrim(rows: readonly { top: number; bottom: number }[], visible: number, keep = 0): number {
  const cut = rows.find(row => row.top < visible - 0.5 && row.bottom > visible + 0.5);
  if (!cut) return 0;
  const trim = Math.ceil(visible - cut.top);
  return visible - trim >= keep ? trim : 0;
}
