import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import * as ui from "./design-system";
import * as compatibility from "./flow-ui";
import { infoRows } from "./information";
import { mobileHubIcon } from "./icons";

test("compatibility entries share the semantic implementation", () => {
  for (const key of ["text", "action", "group", "field", "check", "select", "listRow", "infoRows"] as const) expect(compatibility[key]).toBe(ui[key]);
  expect(infoRows).toBe(ui.infoRows);
});

test("navigation has disclosure; immediate and context actions do not", () => {
  expect(ui.destinationRow("devices", "Devices", "device")).toContain(mobileHubIcon("chevron"));
  expect(ui.action("remove", "Remove", true)).not.toContain("<svg");
  const { document } = parseHTML(ui.listRow("open", "Object", "Detail", "folder") + ui.action("remove", "Remove", true));
  expect(document.querySelectorAll("button[type=button]").length).toBe(2);
  expect(document.querySelector('.mh-list-primary [data-icon="chevron"]')).not.toBeNull();
  expect(document.querySelector('.mh-list-more, [data-flow="more"]')).toBeNull();
  expect(document.querySelector('.mh-destructive [data-icon="chevron"]')).toBeNull();
  expect(document.querySelector(".mh-destructive")?.textContent).toBe("Remove");
});

test("all plain-text seams escape caller strings and preserve exact keys", () => {
  const value = '\"><img src=x onerror="bad"> &';
  const html = ui.text(value) + ui.action(value, value) + ui.group(value, ui.text(value), 2)
    + ui.field(value, value, value, value) + ui.check(value, value, true, value)
    + ui.select(value, value, [{ value, label: value, disabled: true }], value)
    + ui.listRow(value, value, value, "key")
    + ui.destinationRow(value, value, "key", value, value, "green", value)
    + ui.choiceGroup(value, value, value, [[value, value]])
    + ui.infoRows([{ label: value, value, detail: value, mono: true, tone: "warning" }]);
  const { document } = parseHTML(html);
  expect(document.querySelector("img,[onerror]")).toBeNull();
  expect(document.querySelector("[data-flow]")?.getAttribute("data-flow")).toBe(value);
  expect(document.querySelector("[data-credential-id]")?.getAttribute("data-credential-id")).toBe(value);
  expect(document.querySelector("[data-pref]")?.getAttribute("data-pref")).toBe(value);
  expect(document.querySelector(".mh-field input")?.getAttribute("type")).toBe(value);
  expect(document.querySelector("h2 span")?.textContent).toBe("2");
});

test("one-of-many drafts, boolean switches and read-only facts stay distinct", () => {
  const options: Array<[string, string]> = [["left", "Left"], ["right", "Right"]];
  const before = JSON.stringify(options);
  const { document } = parseHTML(ui.choiceGroup("side", "Side", "right", options) + ui.check("enabled", "Enabled") + ui.infoRows([{ label: "Status", value: "Ready" }]));
  expect(document.querySelector("legend")?.textContent).toBe("Side");
  expect(document.querySelectorAll('input[type="radio"][checked]').length).toBe(1);
  expect(document.querySelector('input[type="radio"][checked]')?.getAttribute("value")).toBe("right");
  expect(document.querySelector('input[type="radio"][role="switch"]')).toBeNull();
  expect(document.querySelector('input[role="switch"]')?.getAttribute("type")).toBe("checkbox");
  expect(document.querySelector('input[role="switch"]')?.hasAttribute("checked")).toBe(false);
  expect(document.querySelector("dl input,dl button,dl select")).toBeNull();
  expect(document.querySelector("[onchange],[onclick]")).toBeNull();
  expect(JSON.stringify(options)).toBe(before);
});

test("native fields preserve validation attributes and selected disabled options", () => {
  const { document } = parseHTML(ui.field("name", "Name", "draft", "text", 'required maxlength="64"') + ui.select("tool", "Tool", [{ value: "old", label: "Unavailable", disabled: true }, { value: "new", label: "Available" }], "old"));
  expect(document.querySelector("input")?.hasAttribute("required")).toBe(true);
  expect(document.querySelector("input")?.getAttribute("value")).toBe("draft");
  expect(document.querySelector("option[selected]")?.getAttribute("value")).toBe("old");
  expect(document.querySelector("option[selected]")?.hasAttribute("disabled")).toBe(true);
});
