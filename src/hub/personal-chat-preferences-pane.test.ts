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
  expect(status.textContent).toBe("Saved"); // The previous confirmed save, not the pending selection.
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
  expect(input.checked).toBe(false);
  expect(error.textContent).toContain("another device");
  expect(status.textContent).toBe("Saved");
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
