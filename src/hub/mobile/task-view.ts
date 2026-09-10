import { escapeHtml as esc } from "../../shared/html";

export interface TaskPresentation { kind: "editor" | "confirmation"; cancelLabel?: string; destructive?: boolean }
export interface TaskPrimary { label: string; run(): void | Promise<void> }
export interface TaskPort {
  open(title: string, body: string, primary?: TaskPrimary, cancel?: () => void, presentation?: TaskPresentation): HTMLElement;
  close(): void;
  busy(value: boolean): void;
  error(message: string): void;
}

/** Single task DOM/focus owner. Editors replace the visible page; only explicit
 * confirmations block keyboard traversal. Drafts live solely in these nodes. */
export function createTaskView(host: HTMLElement, foreground: () => boolean, cancel: () => void) {
  let current: HTMLElement | null = null;
  const close = () => {
    current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[type="password"], input[type="file"], textarea[data-secret]').forEach(input => { input.value = ""; });
    current = null; host.replaceChildren();
  };
  const busy = (value: boolean) => { current?.setAttribute("aria-busy", String(value)); if (!value) current?.querySelector("[data-task-pending]")?.remove(); current?.querySelectorAll<HTMLButtonElement>("header button, footer button").forEach(button => { button.disabled = value; }); };
  return {
    close, busy,
    explainPending() {
      if (!current || current.querySelector("[data-task-pending]")) return;
      const notice = host.ownerDocument.createElement("p"); notice.className = "mh-note"; notice.dataset.taskPending = ""; notice.setAttribute("role", "status");
      notice.textContent = "This operation is still pending. Wait for its result before going back.";
      current.querySelector(".mh-sheet-body")?.prepend(notice);
    },
    open(title: string, body: string, primary?: TaskPrimary, presentation: TaskPresentation = { kind: "editor" }) {
      close();
      const confirmation = presentation.kind === "confirmation";
      const button = (action: string, label: string, cls: string) => `<button type="button" data-action="${action}" class="${cls}">${esc(label)}</button>`;
      const controls = button("cancel-sheet", presentation.cancelLabel ?? (primary ? "Cancel" : "Back"), "mh-cancel") + (primary ? button("commit-sheet", primary.label, `mh-commit${confirmation && presentation.destructive !== false ? " mh-destructive" : ""}`) : "");
      host.innerHTML = `${confirmation ? '<div class="mh-confirmation-backdrop">' : ""}<section class="mh-task mh-sheet mh-${presentation.kind}" data-task-kind="${presentation.kind}" role="${confirmation ? "alertdialog" : "region"}" ${confirmation ? 'aria-modal="true"' : ""} aria-label="${esc(title)}" tabindex="-1"><header>${confirmation ? "" : controls}<h${confirmation ? "2" : "1"}>${esc(title)}</h${confirmation ? "2" : "1"}></header><div class="mh-sheet-body">${body}<p class="mh-sheet-error" role="alert"></p></div>${confirmation ? `<footer>${controls}</footer>` : ""}</section>${confirmation ? "</div>" : ""}`;
      const opened = current = host.querySelector<HTMLElement>(".mh-task")!;
      opened.querySelector('[data-action="commit-sheet"]')?.addEventListener("click", () => {
        if (current === opened && foreground() && opened.getAttribute("aria-busy") !== "true") void primary?.run();
      });
      opened.addEventListener("keydown", event => {
        const input = event.target as HTMLInputElement;
        if (event.key === "Enter" && input.tagName === "INPUT" && !["checkbox", "file", "range"].includes(input.type)) {
          const commit = opened.querySelector<HTMLButtonElement>('[data-action="commit-sheet"]');
          if (commit && !commit.disabled) { event.preventDefault(); commit.click(); }
        }
      });
      (opened.querySelector<HTMLElement>("input,select,textarea") ?? opened).focus({ preventScroll: true });
      return opened;
    },
    key(event: KeyboardEvent) {
      if (!current || !foreground()) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); return; }
      if (current.dataset.taskKind !== "confirmation" || event.key !== "Tab") return;
      event.stopPropagation();
      const controls = [...current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')];
      const first = controls[0], last = controls.at(-1), active = host.ownerDocument.activeElement;
      if (!first) { event.preventDefault(); current.focus(); }
      else if (!current.contains(active)) { event.preventDefault(); (event.shiftKey ? last! : first).focus(); }
      else if (event.shiftKey && (active === first || active === current)) { event.preventDefault(); last!.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    },
  };
}
