/** Measure the actual dock/task chrome, including reflow and visual keyboard.
 * No guessed footer height: content reserves precisely the occupied lower area. */
export function observeMobileHubLayout(root: HTMLElement): () => void {
  const win = root.ownerDocument.defaultView;
  if (!win || !win.ResizeObserver || !win.MutationObserver) return () => {};
  let frame = 0;
  const measure = () => {
    frame = 0;
    const bounds = root.getBoundingClientRect();
    const viewport = win.visualViewport;
    const keyboard = viewport ? Math.max(0, bounds.bottom - viewport.offsetTop - viewport.height) : 0;
    root.style.setProperty("--mh-keyboard-clearance", `${keyboard}px`);
    root.style.setProperty("--mh-visible-height", `${Math.max(0, bounds.height - keyboard)}px`);
    const dock = root.querySelector<HTMLElement>(".mh-dock");
    const dockSize = dock ? Math.max(0, bounds.bottom - dock.getBoundingClientRect().top - keyboard) : 0;
    const flow = root.querySelector<HTMLElement>('.mh-flow-page:not([hidden])');
    const toolbarHeight = flow?.querySelector('.mh-flow-toolbar')?.getBoundingClientRect().height ?? 0;
    const promptHeight = flow?.querySelector('.mh-clone-prompt')?.getBoundingClientRect().height ?? 0;
    // Visibility (not display:none) retains a stable intrinsic dock measurement.
    // The decision never depends on the clearance it writes, avoiding oscillation.
    const taskPriority = keyboard > 80 || (!!flow && bounds.height - keyboard - dockSize - toolbarHeight - promptHeight - 52 < 88);
    root.toggleAttribute('data-mh-task-priority', taskPriority);
    if (dock) dock.inert = taskPriority;
    root.style.setProperty("--mh-dock-clearance", `${taskPriority ? 0 : dockSize}px`);
    for (const [selector, property] of [[".mh-overview-toolbar", "--mh-overview-toolbar-height"], [".mh-flow-toolbar", "--mh-flow-toolbar-height"], [".mh-clone-prompt", "--mh-prompt-height"]] as const) {
      const toolbar = root.querySelector<HTMLElement>(selector);
      root.style.setProperty(property, `${toolbar?.getBoundingClientRect().height ?? 0}px`);
    }
  };
  const schedule = () => { if (!frame) frame = win.requestAnimationFrame(measure); };
  const resize = new win.ResizeObserver(schedule);
  const watch = () => { resize.disconnect(); resize.observe(root); root.querySelectorAll(".mh-dock, .mh-flow-toolbar, .mh-overview-toolbar, .mh-clone-prompt, .mh-task header, .mh-task footer").forEach(el => resize.observe(el)); schedule(); };
  const mutation = new win.MutationObserver(watch);
  mutation.observe(root, { childList: true, subtree: true });
  win.visualViewport?.addEventListener("resize", schedule);
  win.visualViewport?.addEventListener("scroll", schedule);
  win.addEventListener("resize", schedule);
  watch();
  return () => { resize.disconnect(); mutation.disconnect(); win.cancelAnimationFrame(frame); win.removeEventListener("resize", schedule); win.visualViewport?.removeEventListener("resize", schedule); win.visualViewport?.removeEventListener("scroll", schedule); };
}
