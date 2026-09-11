import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createFolderPicker, type FolderPickerEnvironment } from "./folder-picker";
import type { FolderListing, ReadResult } from "./backend";

const listing = (path = "/projects"): ReadResult<FolderListing> => ({ status: "available", value: { path, parent: path === "/" ? null : "/", directories: [{ name: "child", git: false, registration: { status: "unregistered" } }] } });
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function harness() {
  const { document } = parseHTML("<html><body><main></main></body></html>");
  const host = document.querySelector("main")!;
  const reads: Array<{ path?: string; resolve(value: ReadResult<FolderListing>): void; reject(error: Error): void }> = [];
  let task = 0, authenticated = true, cancels = 0, lost = 0;
  const choices: string[] = [];
  let primary: () => void | Promise<void> = () => {};
  const env: FolderPickerEnvironment = {
    backend: { browseFolders: path => new Promise((resolve, reject) => reads.push({ path, resolve, reject })) },
    authContext: () => ({ user: "tester", current: () => authenticated }),
    authLost: () => { lost++; authenticated = false; host.replaceChildren(); },
    current: () => { const captured = task; return () => captured === task && !!host.firstChild; },
    sheet: { close: () => { task++; host.replaceChildren(); } },
    task: (title, body, commit, _actions, cancel) => {
      task++;
      host.innerHTML = `<section><header><button data-action="cancel-sheet">Cancel</button><h1>${title}</h1><button data-action="commit-sheet">Choose</button></header><div class="mh-sheet-body">${body}</div></section>`;
      const root = host.firstElementChild as unknown as HTMLElement;
      primary = () => commit?.run(root);
      root.querySelector<HTMLButtonElement>('[data-action="commit-sheet"]')!.onclick = () => { void commit?.run(root); };
      root.querySelector<HTMLButtonElement>('[data-action="cancel-sheet"]')!.onclick = () => cancel?.();
      return root;
    },
  };
  const open = createFolderPicker(env);
  return {
    host, reads, choices, open: (path?: string) => open(path, selected => choices.push(selected), () => cancels++),
    click: (selector: string) => (host.querySelector(selector) as unknown as HTMLButtonElement).click(),
    submit: () => primary(), invalidate: () => { task++; host.replaceChildren(); }, unauthenticate: () => { authenticated = false; },
    get cancels() { return cancels; }, get lost() { return lost; },
  };
}
describe("read-only Hub folder picker", () => {
  test("verified empty root remains selectable without inventing parent or mutation actions", async () => {
    const h = harness(); h.open("/");
    h.reads[0]!.resolve({ status: "available", value: { path: "/", parent: null, directories: [] } }); await settle();
    expect(h.host.querySelector("h1")?.textContent).toBe("Hub folders");
    expect(h.host.querySelector("h1")?.getAttribute("title")).toBe("/");
    expect(h.host.querySelector(".mh-folder-location code")?.textContent).toBe("/");
    expect(h.host.querySelector(".mh-folder-empty h2")?.textContent).toBe("No subfolders");
    expect(h.host.querySelector(".mh-folder-empty p")?.textContent).toBe("Files aren’t shown here. Tap Choose to use this folder.");
    expect(h.host.querySelector(".mh-folder-empty button")).toBeNull();
    expect(h.host.querySelector('[data-flow="up"], [data-flow="create"]')).toBeNull();
    await h.submit(); expect(h.choices).toEqual(["/"]);
  });
  test("starts at caller path; navigation never selects; Choose returns the verified canonical path once", async () => {
    const h = harness(); h.open("/typed"); expect(h.reads[0]!.path).toBe("/typed");
    expect(h.host.querySelector<HTMLButtonElement>('[data-action="commit-sheet"]')!.disabled).toBe(true);
    expect(h.host.querySelector(".mh-empty-state")).toBeNull();
    expect(h.host.querySelector<HTMLButtonElement>('[data-action="cancel-sheet"]')!.disabled).toBe(false);
    await h.submit(); expect(h.choices).toEqual([]);
    h.reads[0]!.resolve(listing()); await settle();
    expect(h.host.querySelector("h1")?.textContent).toBe("projects");
    expect(h.host.querySelector(".mh-folder-picker")?.getAttribute("aria-label")).toBe("Choose Folder");
    expect(h.host.querySelector("input, select, textarea, [data-flow=create], [data-flow=rename], [data-flow=remove]")).toBeNull();
    h.click('[data-flow="folder-0"]'); expect(h.choices).toEqual([]); expect(h.reads[1]!.path).toBe("/projects/child");
    await h.submit(); expect(h.choices).toEqual([]);
    h.reads[1]!.resolve(listing("/canonical/child")); await settle();
    const submit = h.submit; await submit(); await submit(); expect(h.choices).toEqual(["/canonical/child"]);
  });
  for (const thrown of [false, true]) test(`failed child never selects old path and supports Retry/back (${thrown})`, async () => {
    const h = harness(); h.open(); expect(h.reads[0]!.path).toBeUndefined();
    h.reads[0]!.resolve(listing()); await settle(); h.click('[data-flow="folder-0"]');
    if (thrown) h.reads[1]!.reject(new Error("Denied"));
    else h.reads[1]!.resolve({ status: "unavailable", problem: { kind: "unavailable", message: "Denied" } });
    await settle(); expect(h.host.querySelector(".mh-folder-error")).not.toBeNull();
    expect(h.host.querySelector(".mh-empty-state")).toBeNull();
    await h.submit(); expect(h.choices).toEqual([]);
    h.click('[data-flow="retry"]'); expect(h.reads[2]!.path).toBe("/projects/child");
    h.click('[data-flow="last-valid"]'); expect(h.reads[3]!.path).toBe("/projects");
    h.reads[3]!.resolve(listing()); await settle();
    h.reads[2]!.reject(new Error("stale failure")); await settle();
    expect(h.host.querySelector(".mh-folder-error")).toBeNull();
    h.click('[data-action="cancel-sheet"]'); expect(h.cancels).toBe(1); expect(h.choices).toEqual([]);
  });
  for (const exit of ["cancel", "route", "auth"] as const) test(`late result cannot resurrect after ${exit}`, async () => {
    const h = harness(); h.open("/same");
    if (exit === "cancel") h.click('[data-action="cancel-sheet"]');
    else if (exit === "route") h.invalidate(); else h.unauthenticate();
    h.reads[0]!.resolve(listing("/late")); await settle();
    expect(h.host.textContent).not.toContain("/late"); await h.submit(); expect(h.choices).toEqual([]);
  });
  test("same-path reopening rejects earlier completion and auth loss uses the existing owner", async () => {
    const h = harness(); h.open("/same"); h.open("/same");
    h.reads[1]!.resolve(listing("/new")); await settle(); h.reads[0]!.resolve(listing("/old")); await settle();
    expect(h.host.querySelector("h1")?.textContent).toBe("new");
    h.open("/"); h.reads[2]!.resolve({ status: "unavailable", problem: { kind: "unauthorized", message: "Sign in" } }); await settle();
    expect(h.lost).toBe(1); expect(h.choices).toEqual([]);
  });
});
