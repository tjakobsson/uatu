import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createPersonalChatPreferencesPane } from "./personal-chat-preferences-pane";
import { settingsPage } from "./pages";

test("personal preferences show confirmed saved state, conflicts and unavailable without optimistic saves", async () => {
  const { document, window } = parseHTML(settingsPage("alice"));
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let state = { version: 1, revision: 0, autoBackgroundOnSteer: true };
  let failure = false;
  let conflict = false;
  let resolveSave: (() => void) | undefined;
  let saving: Promise<void> | undefined;
  const pane = createPersonalChatPreferencesPane(document, window as unknown as Window, (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (failure) return Response.json({ error: "unavailable" }, { status: 503 });
    if (init?.method === "PUT") {
      if (conflict) return Response.json({ error: "changed", current: state }, { status: 409 });
      saving = new Promise<void>(resolve => { resolveSave = resolve; });
      await saving;
      state = { version: 1, revision: state.revision + 1, autoBackgroundOnSteer: JSON.parse(String(init.body)).autoBackgroundOnSteer };
    }
    return Response.json(state);
  }) as unknown as typeof fetch);
  await pane.reload();
  const input = document.querySelector<HTMLInputElement>("#personal-chat-auto-background")!;
  const form = document.querySelector<HTMLFormElement>("#personal-chat-preferences-form")!;
  const status = document.querySelector("#personal-chat-preferences-status")!;
  const error = document.querySelector("#personal-chat-preferences-error")!;
  expect(input.checked).toBe(true);
  expect(status.textContent).toBe("Saved");
  input.checked = false;
  const pending = form.onsubmit!({ preventDefault() {} } as SubmitEvent);
  await Promise.resolve();
  expect(status.textContent).toBe("Saving…");
  expect(state.autoBackgroundOnSteer).toBe(true);
  expect(input.checked).toBe(false);
  expect(input.disabled).toBe(true);
  resolveSave!();
  await pending;
  expect(status.textContent).toBe("Saved");
  expect(state.autoBackgroundOnSteer).toBe(false);
  expect(input.checked).toBe(false);
  expect(calls.find(call => call.init?.method === "PUT")?.init?.body).toBe('{"version":1,"expectedRevision":0,"autoBackgroundOnSteer":false}');
  conflict = true;
  input.checked = true;
  await form.onsubmit!({ preventDefault() {} } as SubmitEvent);
  expect(input.checked).toBe(true);
  expect(error.textContent).toContain("another device");
  expect(status.textContent).toBe("Unsaved changes — Save to apply.");
  conflict = false;
  failure = true;
  input.checked = true;
  await form.onsubmit!({ preventDefault() {} } as SubmitEvent);
  expect(status.textContent).toBe("Save not confirmed.");
  expect(error.textContent).toContain("could not be saved");
  expect(state.autoBackgroundOnSteer).toBe(false);
  expect(input.disabled).toBe(true);
  await pane.reload();
  expect(status.textContent).toBe("Personal chat preferences are unavailable.");
  expect(error.textContent).toContain("unavailable");
  expect(error.textContent).toContain("cannot confirm");
  expect(error.textContent).toContain("saved preferences may still apply");
  expect(error.textContent).not.toContain("is skipped");
  expect(input.disabled).toBe(true);
  pane.stop();
});

test("Settings loads personal preferences on entry, focus, visibility and reconnect", async () => {
  const { document, window } = parseHTML(settingsPage("alice"));
  let reads = 0;
  const pane = createPersonalChatPreferencesPane(document, window as unknown as Window, (async () => {
    reads++;
    return Response.json({ version: 1, revision: reads, autoBackgroundOnSteer: reads === 1 });
  }) as unknown as typeof fetch);
  await pane.start();
  window.dispatchEvent(new window.Event("focus"));
  window.dispatchEvent(new window.Event("online"));
  Object.defineProperty(document, "visibilityState", { value: "visible" });
  document.dispatchEvent(new window.Event("visibilitychange"));
  await pane.reload();
  expect(reads).toBe(5);
  expect(document.querySelector<HTMLInputElement>("#personal-chat-auto-background")!.checked).toBe(false);
  pane.stop();
  window.dispatchEvent(new window.Event("focus"));
  expect(reads).toBe(5);
});

test("drafts survive focus, visibility, entry and reconnect reads, including edits during an in-flight read", async () => {
  const { document, window } = parseHTML(settingsPage("alice"));
  let release: ((response: Response) => void) | undefined;
  let delayed = false;
  let reads = 0;
  const saved = { version: 1, revision: 0, autoBackgroundOnSteer: true };
  const pane = createPersonalChatPreferencesPane(document, window as unknown as Window, (async () => {
    reads++;
    if (delayed) return new Promise<Response>(resolve => { release = resolve; });
    return Response.json(saved);
  }) as unknown as typeof fetch);
  await pane.start();
  const input = document.querySelector<HTMLInputElement>('[role="switch"]')!;
  const status = document.querySelector('[role="status"]')!;
  const change = (checked: boolean) => { input.checked = checked; input.dispatchEvent(new window.Event("change")); };
  change(false);
  expect(status.textContent).toBe("Unsaved changes — Save to apply.");
  Object.defineProperty(document, "visibilityState", { value: "visible" });
  for (const event of ["focus", "online", "pageshow", "visibilitychange"]) {
    (event === "visibilitychange" ? document : window).dispatchEvent(new window.Event(event));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(input.checked).toBe(false);
    expect(status.textContent).toBe("Unsaved changes — Save to apply.");
  }
  expect(reads).toBe(5);
  change(true);
  expect(status.textContent).toBe("Saved");
  delayed = true;
  const pending = pane.reload();
  change(false);
  release!(Response.json(saved));
  await pending;
  expect(input.checked).toBe(false);
  expect(status.textContent).toBe("Unsaved changes — Save to apply.");
  expect(saved.autoBackgroundOnSteer).toBe(true);
  pane.stop();
});

test("a competing refresh retains the draft's revision until conflict review, then explicit Save applies it", async () => {
  const { document, window } = parseHTML(settingsPage("alice"));
  let saved = { version: 1, revision: 0, autoBackgroundOnSteer: true };
  const revisions: number[] = [];
  const pane = createPersonalChatPreferencesPane(document, window as unknown as Window, (async (_url, init) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      revisions.push(body.expectedRevision);
      if (body.expectedRevision !== saved.revision) return Response.json({ current: saved }, { status: 409 });
      saved = { ...saved, revision: saved.revision + 1, autoBackgroundOnSteer: body.autoBackgroundOnSteer };
    }
    return Response.json(saved);
  }) as typeof fetch);
  await pane.reload();
  const input = document.querySelector<HTMLInputElement>('[role="switch"]')!;
  const form = document.querySelector<HTMLFormElement>("#personal-chat-preferences-form")!;
  const status = document.querySelector('[role="status"]')!;
  input.checked = false;
  input.dispatchEvent(new window.Event("change"));
  saved = { ...saved, revision: 2 }; // Another device saved OFF and then ON.
  await pane.reload();
  expect(input.checked).toBe(false);
  expect(status.textContent).toBe("Unsaved changes — Save to apply.");
  expect(document.querySelector('[role="alert"]')!.textContent).toContain("another device");
  const error = document.querySelector("#personal-chat-preferences-error")!;
  input.checked = true;
  input.dispatchEvent(new window.Event("change"));
  expect(status.textContent).toBe("Saved");
  expect(error.textContent).toContain("The saved setting is ON.");
  expect(error.textContent).toContain("already matches");
  expect(error.textContent).not.toContain("unsaved");
  input.checked = false;
  input.dispatchEvent(new window.Event("change"));
  expect(status.textContent).toBe("Unsaved changes — Save to apply.");
  expect(error.textContent).toContain("Your unsaved choice is kept");
  await form.onsubmit!({ preventDefault() {} } as SubmitEvent);
  expect(revisions).toEqual([0]);
  expect(saved.autoBackgroundOnSteer).toBe(true);
  expect(input.checked).toBe(false);
  expect(status.textContent).toBe("Unsaved changes — Save to apply.");
  await form.onsubmit!({ preventDefault() {} } as SubmitEvent);
  expect(revisions).toEqual([0, 2]);
  expect(saved.autoBackgroundOnSteer).toBe(false);
  expect(status.textContent).toBe("Saved");
  pane.stop();
});

test("conflict guidance follows reverting to the confirmed value and drafting again without writing", async () => {
  const { document, window } = parseHTML(settingsPage("alice"));
  let saved = { version: 1, revision: 0, autoBackgroundOnSteer: true };
  let writes = 0;
  const pane = createPersonalChatPreferencesPane(document, window as unknown as Window, (async (_url, init) => {
    if (init?.method === "PUT") {
      writes++;
      return Response.json({ current: saved }, { status: 409 });
    }
    return Response.json(saved);
  }) as typeof fetch);
  await pane.reload();
  saved = { version: 1, revision: 1, autoBackgroundOnSteer: false };
  const input = document.querySelector<HTMLInputElement>('[role="switch"]')!;
  const status = document.querySelector('[role="status"]')!;
  const error = document.querySelector("#personal-chat-preferences-error")!;
  await document.querySelector<HTMLFormElement>("#personal-chat-preferences-form")!.onsubmit!({ preventDefault() {} } as SubmitEvent);
  expect(status.textContent).toBe("Unsaved changes — Save to apply.");
  expect(error.textContent).toContain("The saved setting is OFF.");
  input.checked = false;
  input.dispatchEvent(new window.Event("change"));
  expect(status.textContent).toBe("Saved");
  expect(error.textContent).toContain("Changed on another device.");
  expect(error.textContent).toContain("The saved setting is OFF.");
  expect(error.textContent).toContain("Your choice already matches the saved setting.");
  expect(error.textContent).not.toContain("unsaved");
  expect(error.textContent).not.toContain("Save ");
  input.checked = true;
  input.dispatchEvent(new window.Event("change"));
  expect(status.textContent).toBe("Unsaved changes — Save to apply.");
  expect(error.textContent).toContain("The saved setting is OFF.");
  expect(error.textContent).toContain("Your unsaved choice is kept");
  expect(error.textContent).toContain("Save");
  expect(error.textContent).not.toContain("already matches");
  expect(writes).toBe(1);
  expect(saved).toEqual({ version: 1, revision: 1, autoBackgroundOnSteer: false });
  pane.stop();
});

test("failed reads preserve drafts and an unknown save is only reconciled by a confirmed read", async () => {
  const { document, window } = parseHTML(settingsPage("alice"));
  let saved = { version: 1, revision: 0, autoBackgroundOnSteer: true };
  let unavailable = false;
  const pane = createPersonalChatPreferencesPane(document, window as unknown as Window, (async (_url, init) => {
    if (unavailable) throw new Error("offline");
    if (init?.method === "PUT") {
      saved = { ...saved, revision: 1, autoBackgroundOnSteer: false };
      throw new Error("Connection lost. Save not confirmed.");
    }
    return Response.json(saved);
  }) as typeof fetch);
  await pane.reload();
  const input = document.querySelector<HTMLInputElement>('[role="switch"]')!;
  const status = document.querySelector('[role="status"]')!;
  input.checked = false;
  input.dispatchEvent(new window.Event("change"));
  unavailable = true;
  await pane.reload();
  expect(input.checked).toBe(false);
  expect(input.disabled).toBe(true);
  expect(status.textContent).toContain("unavailable");
  const error = document.querySelector("#personal-chat-preferences-error")!;
  const unavailableMessage = error.textContent;
  input.dispatchEvent(new window.Event("change"));
  expect(status.textContent).toContain("unavailable");
  expect(error.textContent).toBe(unavailableMessage);
  unavailable = false;
  await pane.reload();
  expect(input.checked).toBe(false);
  expect(input.disabled).toBe(false);
  expect(status.textContent).toBe("Unsaved changes — Save to apply.");
  await document.querySelector<HTMLFormElement>("form#personal-chat-preferences-form")!.onsubmit!({ preventDefault() {} } as SubmitEvent);
  expect(status.textContent).toBe("Save not confirmed.");
  expect(input.disabled).toBe(true);
  const unknownMessage = error.textContent;
  input.dispatchEvent(new window.Event("change"));
  expect(status.textContent).toBe("Save not confirmed.");
  expect(error.textContent).toBe(unknownMessage);
  await pane.reload();
  expect(status.textContent).toBe("Saved");
  expect(input.checked).toBe(false);
  expect(input.disabled).toBe(false);
  pane.stop();
});

test("outdated reads and save completions after stop cannot replace the current pane", async () => {
  const { document, window } = parseHTML(settingsPage("alice"));
  const pending: Array<(response: Response) => void> = [];
  const pane = createPersonalChatPreferencesPane(document, window as unknown as Window, (async () => new Promise<Response>(resolve => pending.push(resolve))) as unknown as typeof fetch);
  const older = pane.reload();
  const newer = pane.reload();
  pending[1]!(Response.json({ version: 1, revision: 2, autoBackgroundOnSteer: false }));
  await newer;
  pending[0]!(Response.json({ version: 1, revision: 0, autoBackgroundOnSteer: true }));
  await older;
  const input = document.querySelector<HTMLInputElement>('[role="switch"]')!;
  const status = document.querySelector('[role="status"]')!;
  expect(input.checked).toBe(false);
  input.checked = true;
  input.dispatchEvent(new window.Event("change"));
  const save = document.querySelector<HTMLFormElement>("form#personal-chat-preferences-form")!.onsubmit!({ preventDefault() {} } as SubmitEvent);
  expect(input.disabled).toBe(true);
  expect(status.textContent).toBe("Saving…");
  pane.stop();
  pending[2]!(Response.json({ version: 1, revision: 3, autoBackgroundOnSteer: true }));
  await save;
  expect(status.textContent).toBe("Saving…");
  expect(input.disabled).toBe(true);
});

test("personal scope and all eligible shells are disclosed separately from machine agent logins", () => {
  const { document } = parseHTML(settingsPage("alice"));
  const section = document.querySelector("#personal-chat-preferences-pane")!;
  expect(section.textContent).toContain("Personal chat preferences");
  expect(section.textContent).toContain("Keep workers running when I steer");
  expect(section.querySelector('[role="switch"]')).not.toBeNull();
  expect(section.querySelector("details")!.hasAttribute("open")).toBe(false);
  expect(section.querySelector("#personal-chat-preferences-help")!.textContent).toBe("Applies to your account on this Hub.");
  expect(section.textContent).toContain("across devices and workspaces");
  expect(section.textContent).toContain("including shell commands");
  expect(section.textContent).toContain("not job starts");
  expect(document.querySelector("#agent-accounts-pane")!.textContent).toContain("this machine");
});
