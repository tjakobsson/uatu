import { appUrl } from "../shared/app-url";
import { appState } from "./state";

let status: HTMLElement | null = null;
let retry: HTMLButtonElement | null = null;
let retrying = false;
export function syncIndexStatus(): void {
  if (!status) {
    const anchor = document.querySelector("#document-count");
    if (!anchor) return;
    status = document.createElement("span"); status.id = "index-status"; status.setAttribute("role", "status");
    retry = document.createElement("button"); retry.type = "button"; retry.textContent = "Retry indexing"; retry.id = "index-retry";
    retry.addEventListener("click", () => { void retryIndex(); });
    anchor.after(status, retry);
  }
  const discovery = appState.discovery;
  status.textContent = discovery.status === "ready" ? "" : discovery.status === "error" ? `Indexing failed: ${discovery.message ?? "Unavailable"}`
    : discovery.status === "recovering" ? "Rebuilding index…" : "Indexing…";
  status.hidden = discovery.status === "ready";
  if (retry) { retry.hidden = discovery.status !== "error"; retry.disabled = retrying; }
}
async function retryIndex() {
  if (retrying) return;
  retrying = true; syncIndexStatus();
  try {
    const response = await fetch(appUrl("/api/index/recover"), { method: "POST", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Index recovery failed (${response.status})`);
  } catch (error) {
    if (status) status.textContent = error instanceof Error ? error.message : "Index recovery failed";
  } finally { retrying = false; if (retry) retry.disabled = false; }
}
