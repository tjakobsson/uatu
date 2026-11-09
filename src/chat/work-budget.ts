/** Expanded cards spend actual remaining layout space, leaving conversation
 * context rather than reserving a percentage of the entire viewport.
 * A measured transcript action floor takes precedence over full work rows;
 * the dock can compact the inactive pane or use its explicit sheet. */
export function expandedWorkBudget(remaining: number, minimumWork: number, density: "desktop" | "comfortable" = "comfortable", minimumReading = 0): { reading: number; capacity: number } {
  const available = Math.max(0, remaining);
  const preferred = density === "desktop"
    ? Math.min(420, Math.max(200, available * 0.5))
    : Math.min(96, Math.max(32, available * 0.2));
  const emergency = Math.min(16, available * 0.1);
  const reading = Math.min(available, Math.max(minimumReading, Math.min(preferred, Math.max(emergency, available - minimumWork))));
  return { reading, capacity: Math.max(0, available - reading) };
}
