// The Hub pages' "← Back to <label>": one link back to where this Hub user
// last was in a workspace on this device (shell/hub-return.ts remembers it),
// pinned to the top of the viewport. Shown only while that workspace is still registered; a
// stopped one is labelled so, and its session URL already offers Start and
// reloads onto the same location. A location that no longer resolves (a
// closed pull request, a deleted file) is the session page's to explain.

import { Buffer } from "node:buffer";

import { hubReturnStorageKey } from "../shared/hub-return";

// The Hub user's storage scope: the same base64url form the Hub's other
// per-user browser keys use. Never a secret: it is the user's own name.
export function hubUserScope(user: string): string {
  return Buffer.from(user).toString("base64url");
}

export function hubReturnKey(user: string): string {
  return hubReturnStorageKey(hubUserScope(user));
}

// The slot is what shows or hides; the link inside it is the control.
export const hubReturnBar = `<div class="hub-return-slot" data-hub-return hidden><a class="hub-return" href="/"><span class="hub-return-arrow" aria-hidden="true">←</span><span class="hub-return-text">Back to <span data-hub-return-label></span></span><span class="hub-return-state" data-hub-return-stopped hidden>Stopped</span></a></div>`;

// One bar pinned to the top of the viewport (below a titlebar inset), above
// the brand header: a compact centred pill on desktop, a full-width 44px row
// on touch-sized screens. It stays in view however the page was scrolled,
// including by an anchor (Settings' #personal-chat-preferences-pane), and
// scroll-padding keeps anchor targets clear of it. Below the started-session
// overlay (z-index 10) and the dialogs.
export const hubReturnStyle = `
  :root { --hub-return-height: 2.75rem; scroll-padding-top: calc(var(--titlebar-inset, 0px) + var(--hub-return-height) + 0.5rem); }
  .hub-return-slot {
    position: sticky;
    top: var(--titlebar-inset, 0px);
    z-index: 5;
    display: flex;
    justify-content: center;
    min-height: var(--hub-return-height);
    align-items: center;
    margin: -2rem -1.25rem 1rem;
    padding: 0.35rem 1.25rem;
    background: var(--surface);
  }
  .hub-return { display: inline-flex; align-items: center; gap: 0.4rem; min-width: 0; max-width: min(100%, 36rem); min-height: 2rem; padding: 0 0.75rem; border: 1px solid var(--accent); border-radius: 0.375rem; color: var(--accent); background: var(--surface); font-size: 0.78rem; font-weight: 600; }
  .hub-return:hover { text-decoration: none; background: var(--accent-soft); }
  .hub-return-arrow { flex-shrink: 0; }
  .hub-return-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hub-return-state { flex-shrink: 0; padding: 0 0.4rem; border-radius: 999px; border: 1px solid var(--border-medium); color: var(--text-subtle); font-size: 0.7rem; font-weight: 600; }
  @media (max-width: 600px) {
    :root { --hub-return-height: calc(44px + 0.7rem); }
    .hub-return { width: 100%; max-width: 100%; min-height: 44px; padding: 0 0.85rem; border-radius: 0.5rem; background: var(--accent-soft); font-size: 0.9rem; }
  }
`;

// Inlined into the page with toString(): self-contained, no imports.
export function mountHubReturn(doc: Document, win: Window, key: string): void {
  const slots = [...doc.querySelectorAll<HTMLElement>("[data-hub-return]")];
  if (slots.length === 0) return;
  const hide = () => { for (const slot of slots) slot.hidden = true; };
  const remembered = (): { workspace: string; label: string; href: string } | null => {
    let value: unknown = null;
    try { value = JSON.parse(win.localStorage.getItem(key) || "null"); } catch { return null; }
    const record = value as { workspace?: unknown; label?: unknown; href?: unknown } | null;
    if (!record || typeof record.workspace !== "string" || typeof record.label !== "string" || typeof record.href !== "string") return null;
    // Only ever a path into that workspace's session on this origin.
    if (record.label === "" || !record.href.startsWith(`/s/${encodeURIComponent(record.workspace)}/`)) return null;
    return { workspace: record.workspace, label: record.label, href: record.href };
  };
  const render = async () => {
    const location = remembered();
    if (!location) { hide(); return; }
    let workspace: { running?: unknown; availability?: unknown } | null = null;
    try {
      const response = await win.fetch("/api/hub/state");
      const state = response.ok ? await response.json() as { workspaces?: unknown } : null;
      const list = Array.isArray(state?.workspaces) ? state.workspaces as { id?: unknown; running?: unknown; availability?: unknown }[] : [];
      workspace = list.find(entry => entry && entry.id === location.workspace) ?? null;
    } catch { workspace = null; }
    // Gone from the Hub, or its checkout missing on disk: nothing to go back to.
    if (!workspace || workspace.availability) { hide(); return; }
    const stopped = workspace.running === false;
    for (const slot of slots) {
      const link = slot.querySelector("a")!;
      link.href = location.href;
      link.querySelector("[data-hub-return-label]")!.textContent = location.label;
      (link.querySelector("[data-hub-return-stopped]") as HTMLElement).hidden = !stopped;
      link.setAttribute("aria-label", `Back to ${location.label}${stopped ? " (stopped)" : ""}`);
      link.title = `Back to ${location.label}${stopped ? " (stopped)" : ""}`;
      slot.hidden = false;
    }
  };
  void render();
  win.addEventListener("pageshow", event => { if ((event as PageTransitionEvent).persisted) void render(); });
}
