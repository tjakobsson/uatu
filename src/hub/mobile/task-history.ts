/** Serializes removal of an ephemeral task entry with coordinator-owned writes.
 * Synchronous close -> result replaces that entry. Plain dismissal traverses
 * back once; writes arriving during traversal are applied only after its pop.
 * This owns no listener, route rendering, operation, or draft. */
export function createTaskHistory(history: Pick<History, "state" | "back" | "pushState" | "replaceState">, url: () => string) {
  type Write = { state: object; url: string; replace: boolean };
  type Close = { url: string; traversing: boolean; write?: Write };
  let closing: Close | undefined;
  let disposed = false;
  const waiters = new Set<() => void>();
  const release = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
  const apply = (write: Write) => history[write.replace ? "replaceState" : "pushState"](write.state, "", write.url);
  const write = (state: object, destination: string, replace: boolean) => {
    if (disposed) return;
    if (closing?.traversing) { closing.write = { state, url: destination, replace }; return; }
    if (closing) { closing = undefined; release(); replace = true; }
    apply({ state, url: destination, replace });
  };
  return {
    write,
    open(context: { route: string; scroll?: number }) { write({ mobileHub: { route: context.route, ...(context.scroll === undefined ? {} : { scroll: context.scroll }), task: true } }, closing?.write?.url ?? url(), false); },
    get contextUrl() { return closing?.write?.url ?? url(); },
    close() {
      if (disposed || closing || !history.state?.mobileHub?.task) return;
      const operation: Close = { url: url(), traversing: false };
      closing = operation;
      // Expire first: Forward can never resurrect this task or replay Save.
      const { task: _, ...context } = history.state.mobileHub;
      history.replaceState({ mobileHub: context }, "", operation.url);
      queueMicrotask(() => {
        if (disposed || closing !== operation) return;
        operation.traversing = true; history.back();
      });
    },
    /** Called at the coordinator's existing pop seam, including pre-boot. */
    consumePop() {
      if (!closing) return false;
      const operation = closing; closing = undefined;
      const owned = operation.traversing && url() === operation.url;
      if (owned && operation.write) apply(operation.write);
      release();
      return owned;
    },
    get pending() { return !!closing; },
    settled() { return closing ? new Promise<void>(resolve => waiters.add(resolve)) : Promise.resolve(); },
    destroy() { disposed = true; closing = undefined; release(); },
  };
}
