import { describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";

import {
  agentControlledModelLabel,
  chatConfigurationPickerGeometry,
  createChatConfigurationPicker,
  configurationOptionLabel,
  filterChatModels,
  groupChatModels,
  modelIdentityLabel,
  modelResultCountLabel,
  type ChatConfigurationPickerElements,
  type ChatConfigurationPickerState,
} from "./configuration-picker";
import type { ChatModel } from "./types";

const models: ChatModel[] = [
  {
    selection: { providerId: "anthropic", modelId: "claude-sonnet-4" },
    provider: "Anthropic",
    name: "Claude Sonnet 4",
    variants: ["fast", "deep"],
  },
  {
    selection: { providerId: "anthropic", modelId: "claude-haiku" },
    provider: "Anthropic",
    name: "Claude Haiku",
  },
  {
    selection: { providerId: "openai", modelId: "gpt-5" },
    provider: "OpenAI",
    name: "GPT-5",
  },
];

describe("configuration picker model helpers", () => {
  it("filters case-insensitively over every model and provider identity field", () => {
    expect(filterChatModels(models, "SONNET")).toEqual([models[0]]);
    expect(filterChatModels(models, "openAI")).toEqual([models[2]]);
    expect(filterChatModels(models, "ANTHROPIC")).toEqual(models.slice(0, 2));
    expect(filterChatModels(models, "GPT-5")).toEqual([models[2]]);
    expect(filterChatModels(models, "  ")).toEqual(models);
  });

  it("preserves provider and model order while removing empty groups", () => {
    const groups = groupChatModels(filterChatModels(models, "claude"));
    expect(groups.map(group => [group.provider, group.providerId])).toEqual([["Anthropic", "anthropic"]]);
    expect(groups[0]!.models).toEqual(models.slice(0, 2));
    expect(groupChatModels([])).toEqual([]);
  });

  it("uses explicit human and agent-controlled labels", () => {
    expect(modelIdentityLabel(models[0]!)).toBe("Anthropic · anthropic/claude-sonnet-4");
    expect(agentControlledModelLabel("OpenCode")).toBe("Let OpenCode choose");
    expect(agentControlledModelLabel()).toBe("Let the agent choose");
    expect(modelResultCountLabel(0)).toBe("0 models");
    expect(modelResultCountLabel(1)).toBe("1 model");
    expect(configurationOptionLabel("build")).toBe("Build");
    expect(configurationOptionLabel("PLAN")).toBe("PLAN");
  });
});

describe("chatConfigurationPickerGeometry", () => {
  const base = {
    surface: { top: 50, right: 1000, bottom: 750, left: 600, width: 400, height: 700 },
    trigger: { top: 690, right: 980, bottom: 730, left: 700, width: 280, height: 40 },
    layoutHeight: 800,
    visualTop: 0,
    visualHeight: 800,
  };

  it("anchors desktop geometry above the trigger and clamps it to Chat", () => {
    expect(chatConfigurationPickerGeometry({ ...base, mode: "desktop" })).toEqual({
      presentation: "desktop",
      left: 608,
      width: 384,
      bottom: 118,
      maxHeight: 480,
    });
  });

  it("intersects the visual viewport with the already-inset touch surface", () => {
    expect(chatConfigurationPickerGeometry({
      ...base,
      mode: "touch",
      surface: { top: 10, right: 390, bottom: 750, left: 0, width: 390, height: 740 },
      visualTop: 10,
      visualHeight: 500,
    })).toEqual({ presentation: "touch", left: 0, width: 390, bottom: 290, maxHeight: 500 });
  });
});

function fixture(mode: "desktop" | "touch" = "desktop") {
  const { document, window } = parseHTML(`<!doctype html><html><body>
    <section id="surface"><button id="trigger">Configure</button></section>
    <dialog id="dialog">
      <button id="done">Done</button>
      <input id="search">
      <section id="models-section"><output id="status"></output><p id="empty"></p><div id="models"></div></section>
      <section id="mode-section"><select id="mode"></select></section>
      <section id="variant-section"><select id="variant"></select></section>
    </dialog>
  </body></html>`);
  const get = <T extends Element>(id: string): T => document.getElementById(id) as unknown as T;
  const dialog = get<HTMLDialogElement>("dialog");
  let activeElement: Element | null = null;
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => activeElement });
  window.HTMLElement.prototype.focus = function () { activeElement = this; };
  dialog.showModal = () => { dialog.setAttribute("open", ""); };
  dialog.close = () => {
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new window.Event("close"));
  };
  const surface = get<HTMLElement>("surface");
  const trigger = get<HTMLElement>("trigger");
  surface.getBoundingClientRect = () => ({ top: 0, right: 500, bottom: 700, left: 100, width: 400, height: 700 } as DOMRect);
  trigger.getBoundingClientRect = () => ({ top: 620, right: 480, bottom: 660, left: 300, width: 180, height: 40 } as DOMRect);

  const elements: ChatConfigurationPickerElements = {
    dialog,
    trigger,
    surface,
    search: get<HTMLInputElement>("search"),
    modelsSection: get<HTMLElement>("models-section"),
    models: get<HTMLElement>("models"),
    resultStatus: get<HTMLElement>("status"),
    empty: get<HTMLElement>("empty"),
    done: get<HTMLButtonElement>("done"),
    modeSection: get<HTMLElement>("mode-section"),
    modeSelect: get<HTMLSelectElement>("mode"),
    variantSection: get<HTMLElement>("variant-section"),
    variantSelect: get<HTMLSelectElement>("variant"),
  };
  const calls = { models: [] as unknown[], modes: [] as unknown[], variants: [] as unknown[] };
  const controller = createChatConfigurationPicker(elements, {
    onModel: value => calls.models.push(value),
    onMode: value => calls.modes.push(value),
    onVariant: value => calls.variants.push(value),
  }, {
    environment: {
      mode: () => mode,
      onModeChange: () => () => {},
      visualViewport: () => null,
      layoutHeight: () => 800,
      addResizeListener: () => {},
      removeResizeListener: () => {},
      defer: callback => callback(),
    },
  });
  const event = (type: string, key?: string): Event => {
    const value = new window.Event(type, { bubbles: true });
    if (key) Object.defineProperty(value, "key", { value: key });
    return value;
  };
  return { document, window, elements, controller, calls, active: () => activeElement, event };
}

const readyState = (): ChatConfigurationPickerState => ({
  agent: { name: "OpenCode", capabilities: ["models", "modes", "variants"] },
  models,
  modes: [{ name: "build", description: "Build changes" }, { name: "plan", description: "Plan changes" }],
  configuration: { model: models[0]!.selection, mode: "build", variant: "deep" },
});

function setSelectValue(select: HTMLSelectElement, value: string): void {
  try {
    select.value = value;
  } catch {
    // linkedom exposes a read-only value; happy-dom and browsers take the assignment.
    Object.defineProperty(select, "value", { configurable: true, value });
  }
}

describe("declared defaults", () => {
  const defaultCatalog: ChatModel[] = [
    { selection: { providerId: "anthropic", modelId: "default" }, provider: "Anthropic", name: "Default (recommended)", detail: "Opus 5 with 1M context", default: true, resolvesTo: { providerId: "anthropic", modelId: "opus[1m]" }, variants: ["low", "high"], contextLimit: 1_000_000 },
    { selection: { providerId: "anthropic", modelId: "opus[1m]" }, provider: "Anthropic", name: "Opus (1M context)", detail: "Opus 5 with 1M context", variants: ["low", "high"], contextLimit: 1_000_000 },
    { selection: { providerId: "anthropic", modelId: "sonnet" }, provider: "Anthropic", name: "Sonnet", variants: ["low", "high"], contextLimit: 200_000 },
  ];
  const defaultState = (): ChatConfigurationPickerState => ({
    agent: { name: "Claude Code", capabilities: ["models", "modes", "variants"] },
    models: defaultCatalog,
    modes: [
      { name: "auto", description: "Claude handles permission decisions", default: true },
      { name: "plan", description: "Create a plan before making changes" },
    ],
    configuration: {},
  });

  it("replaces the delegation rows: default entry pinned and selected, default mode preselected", () => {
    const { elements, controller } = fixture();
    controller.update(defaultState());
    controller.open();
    const rows = [...elements.models.querySelectorAll("button")];
    // No generic "Let ... choose" row; the flagged entry leads, marked selected.
    expect(rows.some(row => row.textContent!.includes("Let Claude Code choose"))).toBe(false);
    expect(rows[0]!.textContent).toContain("Default (recommended)");
    expect(rows[0]!.textContent).toContain("Selected");
    // The identity line carries the agent's own words.
    expect(rows[0]!.textContent).toContain("Opus 5 with 1M context");
    // The mode select offers no unset entry and lands on the declared default.
    const modeValues = [...elements.modeSelect!.options].map(option => option.value);
    // No unset entry at all is the preselection proof linkedom can carry:
    // with only real modes offered, the first (the declared default) leads.
    expect(modeValues).toEqual(["auto", "plan"]);
    // The effort select follows the default entry's variants while unset.
    expect(elements.variantSection!.hasAttribute("hidden")).toBe(false);
    expect([...elements.variantSelect!.options].map(option => option.value)).toEqual(["", "low", "high"]);
    controller.close();
  });

  it("keeps the default entry searchable and counted", () => {
    const { elements, controller, window } = fixture();
    controller.update(defaultState());
    controller.open();
    expect(elements.resultStatus.textContent).toBe("3 models");
    elements.search.value = "recommended";
    elements.search.dispatchEvent(new window.Event("input", { bubbles: true }));
    const rows = [...elements.models.querySelectorAll("button")];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Default (recommended)");
    expect(elements.resultStatus.textContent).toBe("1 model");
    controller.close();
  });

  it("choosing the default entry commits its sentinel selection", () => {
    const { elements, controller, calls, window } = fixture();
    controller.update(defaultState());
    controller.open();
    const row = [...elements.models.querySelectorAll("button")][0]!;
    row.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(calls.models).toEqual([{ providerId: "anthropic", modelId: "default" }]);
    controller.close();
  });
});

describe("configuration picker controller", () => {
  it("renders grouped, selected, unavailable, filtered, and capability-gated content", () => {
    const fixtureValue = fixture();
    const { elements, controller } = fixtureValue;
    controller.update(readyState());
    expect(elements.models.querySelectorAll(".chat-configuration-provider")).toHaveLength(2);
    expect(elements.models.querySelector("[aria-pressed='true']")?.textContent).toContain("Claude Sonnet 4");
    expect(elements.resultStatus.textContent).toBe("3 models");
    expect(elements.modeSection!.hidden).toBe(false);
    expect(elements.variantSection!.hidden).toBe(false);
    expect([...elements.modeSelect!.options].map(option => option.textContent)).toEqual(["Build", "Plan"]);
    expect([...elements.variantSelect!.options].map(option => option.textContent)).toEqual(["Fast", "Deep"]);

    elements.search.value = "OPENAI";
    elements.search.dispatchEvent(new fixtureValue.window.Event("input"));
    expect(elements.models.querySelectorAll(".chat-configuration-provider")).toHaveLength(1);
    expect(elements.resultStatus.textContent).toBe("1 model");

    elements.search.value = "no such model";
    elements.search.dispatchEvent(new fixtureValue.window.Event("input"));
    expect(elements.models.querySelectorAll(".chat-configuration-provider")).toHaveLength(0);
    expect(elements.resultStatus.textContent).toBe("0 models");
    expect(elements.empty.hidden).toBe(false);

    controller.update({
      agent: { name: "Other", capabilities: ["models"] },
      models,
      modes: readyState().modes,
      configuration: { model: { providerId: "gone", modelId: "old" } },
    });
    expect(elements.models.textContent).toContain("Current model, unavailable");
    expect(elements.models.querySelector("button:disabled")?.getAttribute("aria-pressed")).toBe("true");
    expect(elements.modeSection!.hidden).toBe(true);
    expect(elements.variantSection!.hidden).toBe(true);
    controller.destroy();
  });

  it("shares dismissal cleanup and restores focus after desktop autofocus", () => {
    const { elements, controller, active, event } = fixture();
    controller.update(readyState());
    controller.open();
    expect(elements.dialog.hasAttribute("open")).toBe(true);
    expect(active()).toBe(elements.search);
    expect(elements.dialog.dataset.presentation).toBe("desktop");

    elements.variantSelect!.focus();
    elements.variantSelect!.dispatchEvent(event("keydown", "Tab"));
    expect(active()).toBe(elements.done);

    elements.search.value = "claude";
    elements.done.click();
    expect(elements.dialog.hasAttribute("open")).toBe(false);
    expect(elements.search.value).toBe("");
    expect(active()).toBe(elements.trigger);
    controller.destroy();
  });

  it("starts touch mode on a non-editing control and closes on backdrop and Escape", () => {
    const first = fixture("touch");
    first.controller.open();
    expect(first.active()).toBe(first.elements.done);
    first.elements.dialog.dispatchEvent(first.event("click"));
    expect(first.elements.dialog.hasAttribute("open")).toBe(false);

    first.controller.open();
    first.elements.search.dispatchEvent(first.event("keydown", "Escape"));
    expect(first.elements.dialog.hasAttribute("open")).toBe(false);
    first.controller.destroy();
  });

  it("supports arrow navigation, Enter selection, and model-driven reasoning", () => {
    const { elements, controller, calls, active, event } = fixture();
    controller.update(readyState());
    controller.open();

    setSelectValue(elements.modeSelect!, "plan");
    elements.modeSelect!.dispatchEvent(event("change"));
    expect(calls.modes).toEqual(["plan"]);
    setSelectValue(elements.variantSelect!, "fast");
    elements.variantSelect!.dispatchEvent(event("change"));
    expect(calls.variants).toEqual(["fast"]);

    elements.search.dispatchEvent(event("keydown", "ArrowDown"));
    const focused = active() as HTMLButtonElement;
    expect(focused.textContent).toContain("Claude Sonnet 4");
    focused.dispatchEvent(event("keydown", "ArrowDown"));
    const haiku = active() as HTMLButtonElement;
    haiku.dispatchEvent(event("keydown", "Enter"));
    expect(calls.models.at(-1)).toEqual(models[1]!.selection);
    expect(elements.variantSection!.hidden).toBe(true);
    controller.destroy();
  });
});
