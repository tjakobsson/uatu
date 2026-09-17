import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { bindWorktreeBranches } from "./worktree-picker";

function fixture(selection = "", query = "") {
  const { document, window } = parseHTML(`<input data-branch-search><input name="selection"><button data-create>Create</button><div role="listbox"><div id="local" role="option" data-value="local:fix/navigation" data-search="fix/navigation"><span>fix/navigation</span><small>Local</small></div><div id="remote" role="option" data-value="remote:origin/fix/navigation" data-search="origin/fix/navigation"><span>origin/fix/navigation</span><small>Remote</small></div><p data-branch-empty hidden></p></div>`);
  const input = document.querySelector<HTMLInputElement>("[data-branch-search]")!;
  const value = document.querySelector<HTMLInputElement>('[name="selection"]')!;
  const button = document.querySelector<HTMLButtonElement>("button")!;
  const local = document.getElementById("local")!, remote = document.getElementById("remote")!;
  for (const node of [local, remote]) node.scrollIntoView = () => {};
  input.value = query; value.value = selection;
  bindWorktreeBranches(document);
  const edit = (text: string) => { input.value = text; input.dispatchEvent(new window.Event("input")); };
  const key = (key: string) => input.dispatchEvent(Object.assign(new window.Event("keydown", { cancelable: true }), { key }));
  return { input, value, button, local, remote, edit, key, document };
}

describe("editable worktree branch combobox", () => {
  test("click fills exact local/remote ref; every edit invalidates even still-matching text", () => {
    const f = fixture();
    f.edit("fnav"); expect(f.local.hidden).toBe(false); expect(f.remote.hidden).toBe(false);
    f.remote.click(); expect(f.input.value).toBe("origin/fix/navigation");
    expect(f.value.value).toBe("remote:origin/fix/navigation"); expect(f.button.disabled).toBe(false);
    expect(f.input.getAttribute("aria-expanded")).toBe("false");
    f.edit("origin/fix/navigation"); expect(f.value.value).toBe(""); expect(f.button.disabled).toBe(true);
    f.local.click(); expect(f.input.value).toBe("fix/navigation"); expect(f.value.value).toBe("local:fix/navigation");
  });
  test("reopening a committed field reviews all options; Enter chooses and Escape closes", () => {
    const f = fixture(); f.edit("origin"); expect(f.local.hidden).toBe(true);
    f.key("Enter"); expect(f.input.value).toBe("origin/fix/navigation");
    f.input.click(); expect(f.local.hidden).toBe(false); expect(f.remote.hidden).toBe(false);
    expect(f.remote.getAttribute("aria-selected")).toBe("true");
    f.key("Escape"); expect(f.input.getAttribute("aria-expanded")).toBe("false");
    f.key("ArrowDown"); expect(f.input.getAttribute("aria-expanded")).toBe("true");
  });
  test("refreshed valid choice survives; missing choice is cleared while query remains", () => {
    const valid = fixture("remote:origin/fix/navigation", "origin/fix/navigation");
    expect(valid.button.disabled).toBe(false); expect(valid.remote.getAttribute("aria-selected")).toBe("true");
    const missing = fixture("remote:origin/gone", "origin/gone");
    expect(missing.input.value).toBe("origin/gone"); expect(missing.value.value).toBe(""); expect(missing.button.disabled).toBe(true);
    expect(missing.document.querySelector<HTMLElement>("[data-branch-empty]")!.hidden).toBe(false);
  });
});
