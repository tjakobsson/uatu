import type { CompactWorker } from "./compact-work";
import { workerIsActive, workerStateLabel } from "./worker-state";
import { formatTaskElapsed } from "./task-inspection";
import { formatTokens } from "./usage";

const glyphs = { working: "●", unknown: "◌", completed: "✓", failed: "×", stopped: "■" };

/** One keyed row per projected occurrence. Streaming paints retain tap targets. */
export class CompactWorkersView {
  private readonly list = document.createElement("ul");
  private readonly rows = new Map<string, HTMLLIElement>();
  private readonly dismiss = document.createElement("button");

  constructor(private readonly host: HTMLElement, onDismiss?: () => void) {
    this.list.setAttribute("aria-label", "Workers, active first");
    this.dismiss.type = "button";
    this.dismiss.className = "chat-workers-dismiss";
    this.dismiss.textContent = "Dismiss finished";
    this.dismiss.addEventListener("click", event => {
      event.preventDefault(); // The header action must not toggle its disclosure.
      event.stopPropagation();
      onDismiss?.();
    });
    host.replaceChildren(this.list);
    host.parentElement?.querySelector(":scope > summary")?.append(this.dismiss);
  }

  paint(conversation: string | null, workers: readonly CompactWorker[], stopping: ReadonlySet<string>, canStop: boolean): void {
    const focused = document.activeElement;
    const focusedRow = focused instanceof Element && this.host.contains(focused) ? focused.closest<HTMLElement>("[data-worker-id]") : null;
    const ids = new Set(workers.map(worker => worker.id));
    for (const [id, row] of this.rows) if (!ids.has(id)) { row.remove(); this.rows.delete(id); }
    const ordered = [...workers.filter(worker => workerIsActive(worker.state)), ...workers.filter(worker => !workerIsActive(worker.state))];
    for (const [index, worker] of ordered.entries()) {
      let row = this.rows.get(worker.id);
      if (!row) {
        row = document.createElement("li");
        row.dataset.workerId = worker.id;
        row.className = "chat-worker-row";
        const inspect = document.createElement("button");
        inspect.type = "button";
        inspect.className = "chat-worker-inspect";
        for (const part of ["glyph", "name", "meta", "model", "tokens"]) {
          const span = document.createElement("span");
          span.className = `chat-worker-${part}`;
          if (part === "glyph") span.setAttribute("aria-hidden", "true");
          inspect.append(span);
        }
        row.append(inspect);
        this.rows.set(worker.id, row);
      }
      row.dataset.state = worker.state;
      if (worker.taskId) row.dataset.backgroundTask = worker.taskId;
      const inspect = row.firstElementChild as HTMLButtonElement;
      inspect.dataset.workerItem = worker.id;
      if (worker.taskId) inspect.dataset.inspectTask = worker.taskId;
      inspect.title = worker.name;
      inspect.setAttribute("aria-label", [worker.name, workerStateLabel(worker.state), worker.model, worker.tokens === undefined ? undefined : `${worker.tokens.toLocaleString()} cumulative tokens`].filter(Boolean).join(" · "));
      // The handler looks up the current row model, not a stale closure.
      inspect.querySelector(".chat-worker-glyph")!.textContent = glyphs[worker.state];
      inspect.querySelector(".chat-worker-name")!.textContent = worker.name;
      const meta = inspect.querySelector<HTMLElement>(".chat-worker-meta")!;
      meta.textContent = [worker.kind === "shell" ? "Shell worker" : "Agent", workerStateLabel(worker.state)].join(" · ");
      if (worker.since) {
        const time = document.createElement("span");
        if (workerIsActive(worker.state)) {
          time.dataset.elapsedSince = String(worker.since);
          time.textContent = formatTaskElapsed(Date.now() - worker.since);
        } else {
          const clock = new Date(worker.settledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          time.textContent = worker.settledAt === worker.since ? `Started ${clock}` : clock;
        }
        meta.append(" · ", time);
      }
      if (worker.progress) meta.append(` · ${worker.progress}`);
      const model = inspect.querySelector<HTMLElement>(".chat-worker-model")!;
      model.textContent = worker.model ?? "—";
      model.title = worker.model ?? "Model not reported";
      const tokens = inspect.querySelector<HTMLElement>(".chat-worker-tokens")!;
      tokens.textContent = worker.tokens === undefined ? "—" : `Σ ${formatTokens(worker.tokens)}`;
      tokens.title = worker.tokens === undefined ? "Cumulative usage not reported" : `${worker.tokens.toLocaleString()} cumulative tokens, not context occupancy`;
      inspect.dataset.kind = worker.kind;
      let stop = row.querySelector<HTMLButtonElement>("[data-stop-task]");
      if (worker.taskId && worker.stoppable && workerIsActive(worker.state) && canStop) {
        if (!stop) {
          stop = document.createElement("button");
          stop.type = "button";
          stop.className = "chat-task-stop";
          row.append(stop);
        }
        stop.dataset.stopTask = worker.taskId;
        stop.dataset.stopItem = worker.id;
        stop.textContent = stopping.has(worker.taskId) ? "Stopping…" : "Stop worker";
        stop.disabled = worker.state === "unknown" || stopping.has(worker.taskId);
        stop.setAttribute("aria-label", `Stop worker: ${worker.name}`);
        stop.title = worker.state === "unknown" ? "Status unknown — refresh before stopping" : `Stop worker: ${worker.name}`;
      } else stop?.remove();
      // Append only where order actually changed; do not detach a focused row.
      if (this.list.children[index] !== row) this.list.insertBefore(row, this.list.children[index] ?? null);
    }
    const settled = workers.filter(worker => !workerIsActive(worker.state));
    this.dismiss.hidden = !settled.length;
    if (focused === this.dismiss && this.dismiss.hidden) this.host.parentElement?.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
    if (focusedRow && (!(focused as Element).isConnected || (focused as Element).matches(":disabled"))) {
      const surviving = this.rows.get(focusedRow.dataset.workerId!);
      const target = surviving ? surviving.querySelector<HTMLElement>(".chat-worker-inspect") : this.host.parentElement?.querySelector<HTMLElement>(":scope > summary");
      target?.focus({ preventScroll: true });
    }
  }
}
