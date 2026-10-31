import type { CompactWorker } from "./compact-work";
import { workerIsActive, workerStateLabel } from "./worker-state";
import { formatTaskElapsed } from "./task-inspection";
import { formatTokens } from "./usage";
import { formatWorkerCost } from "./worker-session";
import { workerDismissible } from "./worker-dismissal-client";

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

  /** Intrinsic body extent, not the scrollport space allocated by the dock.
   * Reading scrollHeight here would preserve a stale minimum after rows shrink
   * (for example 320→390px), because it cannot be smaller than clientHeight.
   * The single unconstrained list box already includes row borders and gaps.
   */
  contentHeight(): number {
    const css = (element: HTMLElement) => typeof getComputedStyle === "function" ? getComputedStyle(element) : element.style;
    const host = css(this.host), list = css(this.list);
    const pixels = (value: string) => parseFloat(value) || 0;
    return this.list.getBoundingClientRect().height + pixels(list.marginTop) + pixels(list.marginBottom)
      + pixels(host.paddingTop) + pixels(host.paddingBottom) + pixels(host.borderTopWidth) + pixels(host.borderBottomWidth);
  }

  paint(conversation: string | null, workers: readonly CompactWorker[], stopping: ReadonlySet<string>, canStop: boolean): void {
    const focused = document.activeElement;
    const focusedRow = focused instanceof Element && this.host.contains(focused) ? focused.closest<HTMLLIElement>("[data-worker-id]") : null;
    const ids = new Set(workers.map(worker => worker.id));
    for (const [id, row] of this.rows) if (!ids.has(id)) { row.remove(); this.rows.delete(id); }
    const ordered = [...workers.filter(worker => workerIsActive(worker.state)), ...workers.filter(worker => !workerIsActive(worker.state))];
    for (const worker of ordered) {
      let row = this.rows.get(worker.id);
      if (!row) {
        row = document.createElement("li");
        row.dataset.workerId = worker.id;
        row.className = "chat-worker-row";
        const inspect = document.createElement("button");
        inspect.type = "button";
        inspect.className = "chat-worker-inspect";
        for (const part of ["glyph", "name", "meta", "model", "tokens", "cost"]) {
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
      if (worker.activity?.kind === "needs-answer" && worker.activity.request) inspect.dataset.workerRequest = worker.activity.request.id;
      else delete inspect.dataset.workerRequest;
      if (worker.taskId) {
        inspect.dataset.inspectTask = worker.taskId;
        inspect.dataset.inspectView = worker.kind === "shell" ? "output" : "transcript";
      }
      inspect.title = worker.name;
      const stateLabel = workerStateLabel(worker.state, false, worker.activity);
      const effortLabel = worker.effort == null ? "Reasoning effort not reported" : `Last-used reasoning effort: ${worker.effort}`;
      const costLabel = worker.costUsd == null ? "Subagent session cost not reported" : `Cumulative subagent session cost: ${worker.costUsd} USD`;
      inspect.setAttribute("aria-label", [worker.name, worker.agent, stateLabel, worker.model, worker.kind === "agent" ? effortLabel : undefined, worker.tokens === undefined ? undefined : `${worker.tokens.toLocaleString()} cumulative tokens`, worker.kind === "agent" ? costLabel : undefined].filter(Boolean).join(" · "));
      // The handler looks up the current row model, not a stale closure.
      inspect.querySelector(".chat-worker-glyph")!.textContent = glyphs[worker.state];
      inspect.querySelector(".chat-worker-name")!.textContent = worker.name;
      const meta = inspect.querySelector<HTMLElement>(".chat-worker-meta")!;
      const kind = document.createElement("span");
      kind.className = "chat-worker-kind";
      kind.textContent = worker.kind === "shell" ? "Shell" : worker.agent ?? "Agent";
      meta.replaceChildren(kind);
      const showStatus = worker.state === "unknown" || worker.activity !== undefined && worker.state === "working";
      if (showStatus) {
        const status = document.createElement("span");
        status.className = "chat-worker-status";
        status.textContent = stateLabel;
        meta.append(" · ", status);
      }
      const clockRunning = worker.state === "working" && worker.clockRunning !== false && worker.activity?.kind !== "needs-answer";
      if (worker.activity?.kind === "ended") {
        const end = document.createElement("span");
        end.className = "chat-worker-clock";
        end.textContent = worker.activity.endedAt === undefined ? "End time unknown" : `Ended ${new Date(worker.activity.endedAt).toLocaleString()}`;
        meta.append(" · ", end);
      }
      if ((clockRunning || !workerIsActive(worker.state)) && (worker.since || worker.completedAt !== undefined || worker.terminalReportedAt !== undefined)) {
        const time = document.createElement("span");
        time.className = "chat-worker-clock";
        if (clockRunning) {
          time.dataset.elapsedSince = String(worker.since);
          time.textContent = formatTaskElapsed(Date.now() - worker.since);
        } else {
          const clock = new Date(worker.settledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
          time.textContent = worker.completedAt !== undefined ? clock : worker.terminalReportedAt !== undefined ? `Reported ${clock}` : worker.settledAt === worker.since ? `Started ${clock}` : clock;
        }
        if (!workerIsActive(worker.state) || worker.kind === "shell") {
          const suffix = document.createElement("span");
          suffix.className = "chat-worker-time";
          suffix.append(" · ", time);
          meta.append(suffix);
        }
      }
      meta.title = [meta.textContent, showStatus ? undefined : stateLabel, worker.progress].filter(Boolean).join(" · ");
      const model = inspect.querySelector<HTMLElement>(".chat-worker-model")!;
      const modelName = document.createElement("span");
      modelName.className = "chat-worker-model-name";
      modelName.textContent = worker.model ?? "—";
      const effort = document.createElement("span");
      effort.className = "chat-worker-effort";
      effort.textContent = worker.effort ?? "—";
      effort.title = effortLabel;
      effort.setAttribute("aria-label", effortLabel);
      model.replaceChildren(modelName);
      if (worker.kind === "agent") model.append(" · ", effort);
      model.title = [worker.model ?? "Model not reported", worker.kind === "agent" ? effortLabel : undefined].filter(Boolean).join(" · ");
      const tokens = inspect.querySelector<HTMLElement>(".chat-worker-tokens")!;
      tokens.textContent = worker.tokens === undefined ? "—" : `Σ ${formatTokens(worker.tokens)}`;
      tokens.title = worker.tokens === undefined ? "Cumulative usage not reported" : `${worker.tokens.toLocaleString()} cumulative tokens, not context occupancy`;
      const cost = inspect.querySelector<HTMLElement>(".chat-worker-cost")!;
      cost.textContent = worker.kind === "agent" ? formatWorkerCost(worker.costUsd) : "—";
      cost.title = worker.kind === "agent" ? costLabel : "Session cost not applicable to shell tasks";
      cost.setAttribute("aria-label", cost.title);
      inspect.dataset.kind = worker.kind;
      let stop = row.querySelector<HTMLButtonElement>("[data-stop-task]");
      if (worker.taskId && worker.stoppable && worker.state === "working" && canStop) {
        if (!stop) {
          stop = document.createElement("button");
          stop.type = "button";
          stop.className = "chat-task-stop";
          row.append(stop);
        }
        stop.dataset.stopTask = worker.taskId;
        stop.dataset.stopItem = worker.id;
        stop.textContent = stopping.has(worker.taskId) ? "Stopping…" : "Stop";
        stop.disabled = stopping.has(worker.taskId) || worker.controlAvailable === false;
        stop.setAttribute("aria-label", `Stop worker: ${worker.name}`);
        stop.title = worker.controlAvailable === false ? worker.controlReason ?? "Stop unavailable: execution proof is unverified" : `Stop worker: ${worker.name}`;
      } else stop?.remove();
      let dismiss = row.querySelector<HTMLButtonElement>("[data-dismiss-worker]");
      if (workerDismissible(worker) && worker.state === "unknown") {
        if (!dismiss) {
          dismiss = document.createElement("button");
          dismiss.type = "button";
          dismiss.className = "chat-worker-dismiss";
          row.append(dismiss);
        }
        dismiss.dataset.dismissWorker = worker.id;
        dismiss.textContent = "Dismiss";
        dismiss.setAttribute("aria-label", `Dismiss worker from summary: ${worker.name}`);
      } else dismiss?.remove();
    }
    // Reorder siblings around the focused row. Moving that row itself with
    // insertBefore drops native focus even though its buttons remain connected.
    const orderedRows = ordered.map(worker => this.rows.get(worker.id)!);
    const anchor = focusedRow && orderedRows.includes(focusedRow) ? focusedRow : null;
    const anchorIndex = anchor ? orderedRows.indexOf(anchor) : -1;
    if (anchor) {
      let before = anchor;
      for (let index = anchorIndex - 1; index >= 0; index--) {
        const row = orderedRows[index]!;
        if (row.nextElementSibling !== before) this.list.insertBefore(row, before);
        before = row;
      }
    }
    let cursor = anchor ? anchor.nextElementSibling : this.list.firstElementChild;
    for (const row of orderedRows.slice(anchorIndex + 1)) {
      if (row === cursor) cursor = cursor.nextElementSibling;
      else this.list.insertBefore(row, cursor);
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
