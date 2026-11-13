import type { ConversationItem, WorkerActivity } from "./types";

/** Follow a positively linked reference; the existing card owns all answers. */
export function revealWorkerRequest(activity: WorkerActivity | undefined, items: readonly ConversationItem[], reveal: (id: string) => HTMLElement | null): boolean {
  if (activity?.kind !== "needs-answer" || !activity.request) return false;
  const reference = activity.request;
  const matches = items.filter(item => (item.type === "question" || item.type === "permission")
    && item.type === reference.kind && item.status === "pending" && (item.id === reference.id || item.requestId === reference.id));
  const exact = matches.filter(item => item.id === reference.id);
  const request = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined;
  if (!request) return false;
  const node = reveal(request.id);
  if (!node) return false;
  const details = node.matches("details") ? node as HTMLDetailsElement : node.querySelector("details");
  if (details) details.open = true;
  const control = node.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)');
  if (control) control.focus({ preventScroll: true });
  else { node.tabIndex = -1; node.focus({ preventScroll: true }); }
  return true;
}
