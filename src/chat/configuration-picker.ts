import { onUiModeChange, uiMode, type UiMode } from "../shell/ui-mode";
import type {
  ChatAgent,
  ChatCapability,
  ChatMode,
  ChatModel,
  ConversationConfiguration,
  ModelSelection,
} from "./types";

export type ModelGroup = {
  provider: string;
  providerId: string;
  models: ChatModel[];
};

export function filterChatModels(models: ChatModel[], query: string): ChatModel[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...models];
  return models.filter(model => [
    model.name,
    model.provider,
    model.selection.providerId,
    model.selection.modelId,
  ].some(value => value.toLocaleLowerCase().includes(needle)));
}

export function groupChatModels(models: ChatModel[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const model of models) {
    const key = `${model.selection.providerId}\u0000${model.provider}`;
    const group = groups.get(key);
    if (group) group.models.push(model);
    else groups.set(key, {
      provider: model.provider,
      providerId: model.selection.providerId,
      models: [model],
    });
  }
  return [...groups.values()];
}

export function modelIdentityLabel(model: ChatModel): string {
  return model.detail ?? `${model.provider} · ${model.selection.providerId}/${model.selection.modelId}`;
}

export function agentControlledModelLabel(agentName?: string): string {
  return `Let ${agentName || "the agent"} choose`;
}

export function modelResultCountLabel(count: number): string {
  return `${count} ${count === 1 ? "model" : "models"}`;
}

export function configurationOptionLabel(value: string): string {
  if (!value) return value;
  // "xhigh" is Claude's abbreviation for the effort tier above high; no
  // casing rule can recover the words, so it is named here.
  if (value === "xhigh") return "Extra high";
  // Wire values arrive as lowercase words ("build") or camelCase
  // ("acceptEdits"); both read as sentence case ("Build", "Accept edits").
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, (_match, before: string, after: string) => `${before} ${after.toLocaleLowerCase()}`);
  return spaced.charAt(0).toLocaleUpperCase() + spaced.slice(1);
}

type Rect = Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width" | "height">;

export type PickerGeometryInput = {
  mode: UiMode;
  surface: Rect;
  trigger: Rect;
  layoutHeight: number;
  visualTop: number;
  visualHeight: number;
};

export type PickerGeometry = {
  presentation: UiMode;
  left: number;
  width: number;
  bottom: number;
  maxHeight: number;
};

const DIALOG_GAP = 8;
const DESKTOP_WIDTH = 420;
const DESKTOP_MAX_HEIGHT = 480;

export function chatConfigurationPickerGeometry(input: PickerGeometryInput): PickerGeometry {
  const surfaceLeft = Math.max(0, input.surface.left);
  const surfaceRight = Math.max(surfaceLeft, input.surface.right);
  if (input.mode === "touch") {
    const visualBottom = input.visualTop + input.visualHeight;
    const usableTop = Math.max(input.visualTop, input.surface.top);
    const usableBottom = Math.max(usableTop, Math.min(visualBottom, input.surface.bottom));
    return {
      presentation: "touch",
      left: surfaceLeft,
      width: Math.max(0, surfaceRight - surfaceLeft),
      bottom: Math.max(0, input.layoutHeight - usableBottom),
      maxHeight: Math.max(0, usableBottom - usableTop),
    };
  }

  const width = Math.min(DESKTOP_WIDTH, Math.max(0, surfaceRight - surfaceLeft - DIALOG_GAP * 2));
  const minimumLeft = surfaceLeft + DIALOG_GAP;
  const maximumLeft = Math.max(minimumLeft, surfaceRight - DIALOG_GAP - width);
  const left = Math.min(maximumLeft, Math.max(minimumLeft, input.trigger.right - width));
  return {
    presentation: "desktop",
    left,
    width,
    bottom: Math.max(0, input.layoutHeight - input.trigger.top + DIALOG_GAP),
    maxHeight: Math.min(DESKTOP_MAX_HEIGHT, Math.max(0, input.trigger.top - input.surface.top - DIALOG_GAP * 2)),
  };
}

export type ChatConfigurationPickerState = {
  agent?: Pick<ChatAgent, "name" | "capabilities">;
  models: ChatModel[];
  modes: ChatMode[];
  configuration: ConversationConfiguration;
};

export type ChatConfigurationPickerElements = {
  dialog: HTMLDialogElement;
  trigger: HTMLElement;
  surface: HTMLElement;
  search: HTMLInputElement;
  modelsSection: HTMLElement;
  models: HTMLElement;
  resultStatus: HTMLElement;
  empty: HTMLElement;
  done: HTMLButtonElement;
  modeSection?: HTMLElement;
  modeSelect?: HTMLSelectElement;
  variantSection?: HTMLElement;
  variantSelect?: HTMLSelectElement;
  touchInitialFocus?: HTMLElement;
};

export type ChatConfigurationPickerCallbacks = {
  onModel: (selection: ModelSelection | undefined) => void;
  onMode: (mode: string | undefined) => void;
  onVariant: (variant: string | undefined) => void;
};

type PickerEnvironment = {
  mode: () => UiMode;
  onModeChange: (listener: (mode: UiMode) => void) => () => void;
  visualViewport: () => Pick<VisualViewport, "height" | "offsetTop" | "addEventListener" | "removeEventListener"> | null;
  layoutHeight: () => number;
  addResizeListener: (listener: () => void) => void;
  removeResizeListener: (listener: () => void) => void;
  defer: (callback: () => void) => void;
};

export type ChatConfigurationPickerOptions = {
  environment?: Partial<PickerEnvironment>;
};

export type ChatConfigurationPickerController = {
  open(): void;
  close(): void;
  update(state: ChatConfigurationPickerState): void;
  destroy(): void;
};

function sameModel(left: ModelSelection | undefined, right: ModelSelection | undefined): boolean {
  return left?.providerId === right?.providerId && left?.modelId === right?.modelId;
}

function declares(state: ChatConfigurationPickerState, capability: ChatCapability): boolean {
  return state.agent?.capabilities.includes(capability) ?? true;
}

function setSectionVisible(section: HTMLElement | undefined, visible: boolean): void {
  if (section) section.hidden = !visible;
}

function addOption(select: HTMLSelectElement, label: string, value: string, disabled = false): HTMLOptionElement {
  const option = select.ownerDocument.createElement("option");
  option.textContent = label;
  option.value = value;
  option.disabled = disabled;
  select.append(option);
  return option;
}

function selectOption(select: HTMLSelectElement, value: string): void {
  for (const option of select.options) option.selected = option.value === value;
}

function selectedValue(select: HTMLSelectElement | undefined): string | undefined {
  if (!select) return undefined;
  return select.value || [...select.options].find(option => option.selected)?.value || undefined;
}

export function createChatConfigurationPicker(
  elements: ChatConfigurationPickerElements,
  callbacks: ChatConfigurationPickerCallbacks,
  options: ChatConfigurationPickerOptions = {},
): ChatConfigurationPickerController {
  const browser = typeof window === "undefined" ? null : window;
  const environment: PickerEnvironment = {
    mode: options.environment?.mode ?? uiMode,
    onModeChange: options.environment?.onModeChange ?? onUiModeChange,
    visualViewport: options.environment?.visualViewport ?? (() => browser?.visualViewport ?? null),
    layoutHeight: options.environment?.layoutHeight ?? (() => browser?.innerHeight ?? 0),
    addResizeListener: options.environment?.addResizeListener ?? (listener => browser?.addEventListener("resize", listener)),
    removeResizeListener: options.environment?.removeResizeListener ?? (listener => browser?.removeEventListener("resize", listener)),
    defer: options.environment?.defer ?? (callback => requestAnimationFrame(callback)),
  };

  let state: ChatConfigurationPickerState = { models: [], modes: [], configuration: {} };
  let open = false;
  let activeModelValue = "";

  const selectableRows = (): HTMLButtonElement[] => [...elements.models.querySelectorAll<HTMLButtonElement>(
    "button[data-model-value]",
  )].filter(row => !row.disabled);

  const focusRow = (index: number): void => {
    const rows = selectableRows();
    if (rows.length === 0) return;
    const wrapped = (index + rows.length) % rows.length;
    rows.forEach((row, candidate) => { row.tabIndex = candidate === wrapped ? 0 : -1; });
    activeModelValue = rows[wrapped]!.dataset.modelValue ?? "";
    rows[wrapped]!.focus();
  };

  const makeModelRow = (
    primary: string,
    secondary: string,
    value: string,
    selected: boolean,
    disabled: boolean,
    onSelect?: () => void,
    title?: string,
  ): HTMLButtonElement => {
    const button = elements.dialog.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "chat-configuration-model";
    button.dataset.modelValue = value;
    button.disabled = disabled;
    button.setAttribute("aria-pressed", String(selected));

    const name = button.ownerDocument.createElement("span");
    name.className = "chat-configuration-model-name";
    name.textContent = primary;
    const identity = button.ownerDocument.createElement("span");
    identity.className = "chat-configuration-model-identity";
    identity.textContent = secondary;
    button.append(name, identity);
    if (selected) {
      const marker = button.ownerDocument.createElement("span");
      marker.className = "chat-configuration-model-selected";
      marker.textContent = "Selected";
      button.append(marker);
    }
    button.setAttribute("aria-label", [primary, secondary, selected ? "selected" : ""].filter(Boolean).join(", "));
    if (title) button.title = title;
    if (title) button.title = title;
    if (onSelect) button.addEventListener("click", onSelect);
    return button;
  };

  const renderFooter = (): void => {
    const modeAvailable = declares(state, "modes") && state.modes.length > 0;
    setSectionVisible(elements.modeSection, modeAvailable);
    if (elements.modeSelect) {
      elements.modeSelect.replaceChildren();
      if (modeAvailable) {
        const defaultMode = state.modes.find(mode => mode.default);
        if (!state.configuration.mode && !defaultMode) addOption(elements.modeSelect, `Let ${state.agent?.name || "the agent"} choose`, "");
        for (const mode of state.modes) {
          const option = addOption(elements.modeSelect, configurationOptionLabel(mode.name), mode.name);
          if (mode.description) option.title = mode.description;
        }
        const selectedMode = state.configuration.mode;
        if (selectedMode && !state.modes.some(mode => mode.name === selectedMode)) {
          addOption(elements.modeSelect, `${configurationOptionLabel(selectedMode)} (current, unavailable)`, selectedMode, true);
        }
        selectOption(elements.modeSelect, selectedMode ?? defaultMode?.name ?? "");
      }
    }

    // While no model is chosen, the declared default IS the active model:
    // its effort levels are the ones a prompt would actually run under.
    const displayedModel = state.configuration.model
      ? state.models.find(model => sameModel(model.selection, state.configuration.model))
      : state.models.find(model => model.default);
    const variants = displayedModel?.variants ?? [];
    const variantAvailable = declares(state, "variants") && variants.length > 0;
    setSectionVisible(elements.variantSection, variantAvailable);
    if (elements.variantSelect) {
      elements.variantSelect.replaceChildren();
      if (variantAvailable) {
        if (!state.configuration.variant) addOption(elements.variantSelect, `Let ${state.agent?.name || "the agent"} choose reasoning`, "");
        for (const variant of variants) addOption(elements.variantSelect, configurationOptionLabel(variant), variant);
        const selectedVariant = state.configuration.variant;
        if (selectedVariant && !variants.includes(selectedVariant)) {
          addOption(elements.variantSelect, `${configurationOptionLabel(selectedVariant)} (current, unavailable)`, selectedVariant, true);
        }
        selectOption(elements.variantSelect, selectedVariant ?? "");
      }
    }
  };

  const renderModels = (): void => {
    const modelAvailable = declares(state, "models");
    setSectionVisible(elements.modelsSection, modelAvailable);
    elements.models.replaceChildren();
    if (!modelAvailable) {
      elements.resultStatus.textContent = "";
      elements.empty.hidden = true;
      renderFooter();
      return;
    }

    const selected = state.configuration.model;
    const defaultModel = state.models.find(model => model.default);
    // The default entry is searchable like any other; it renders pinned
    // above the provider groups whenever the search does not exclude it.
    const filtered = filterChatModels(state.models, elements.search.value);
    const defaultVisible = defaultModel !== undefined && filtered.includes(defaultModel);
    if (defaultVisible || !elements.search.value.trim()) {
      if (defaultModel) {
        elements.models.append(makeModelRow(
          defaultModel.name,
          modelIdentityLabel(defaultModel),
          `${defaultModel.selection.providerId}/${defaultModel.selection.modelId}`,
          !selected || sameModel(defaultModel.selection, selected),
          false,
          () => {
            state = { ...state, configuration: { ...state.configuration, model: defaultModel.selection } };
            callbacks.onModel(defaultModel.selection);
            renderModels();
          },
        ));
      } else if (!selected) {
        elements.models.append(makeModelRow(
          agentControlledModelLabel(state.agent?.name),
          "Agent-controlled model",
          "",
          true,
          false,
        ));
      }
    }

    const selectedAvailable = !selected || state.models.some(model => sameModel(model.selection, selected));
    if (selected && !selectedAvailable) {
      elements.models.append(makeModelRow(
        `${selected.providerId}/${selected.modelId}`,
        "Current model, unavailable",
        `${selected.providerId}/${selected.modelId}`,
        true,
        true,
      ));
    }

    for (const group of groupChatModels(filtered.filter(model => !model.default))) {
      const section = elements.dialog.ownerDocument.createElement("section");
      section.className = "chat-configuration-provider";
      section.dataset.providerId = group.providerId;
      const heading = section.ownerDocument.createElement("h3");
      heading.textContent = group.provider;
      section.append(heading);
      for (const model of group.models) {
        const value = `${model.selection.providerId}/${model.selection.modelId}`;
        section.append(makeModelRow(
          model.name,
          modelIdentityLabel(model),
          value,
          sameModel(model.selection, selected),
          false,
          () => {
            const changed = !sameModel(state.configuration.model, model.selection);
            const hadVariant = changed && state.configuration.variant !== undefined;
            state = {
              ...state,
              configuration: {
                ...state.configuration,
                model: model.selection,
                variant: changed ? undefined : state.configuration.variant,
              },
            };
            callbacks.onModel(model.selection);
            if (hadVariant) callbacks.onVariant(undefined);
            renderModels();
          },
          model.resolvesTo ? `${model.selection.providerId}/${model.selection.modelId} → ${model.resolvesTo.modelId}` : `${model.selection.providerId}/${model.selection.modelId}`,
        ));
      }
      elements.models.append(section);
    }

    elements.resultStatus.textContent = modelResultCountLabel(filtered.length);
    elements.empty.hidden = filtered.length !== 0;
    if (filtered.length === 0) {
      elements.empty.textContent = state.models.length === 0
        ? "No models are available."
        : "No models match your search.";
    }

    const rows = selectableRows();
    const activeIndex = rows.findIndex(row => row.dataset.modelValue === activeModelValue);
    rows.forEach((row, index) => { row.tabIndex = index === Math.max(0, activeIndex) ? 0 : -1; });
    activeModelValue = rows[Math.max(0, activeIndex)]?.dataset.modelValue ?? "";
    renderFooter();
  };

  const applyGeometry = (): void => {
    if (!open) return;
    const viewport = environment.visualViewport();
    // ChatViewportController already sizes the touch surface above the visible
    // tab bar and its safe area, reclaiming that space when the keyboard covers
    // it. Clamp to that surface instead of subtracting the inset a second time.
    const geometry = chatConfigurationPickerGeometry({
      mode: environment.mode(),
      surface: elements.surface.getBoundingClientRect(),
      trigger: elements.trigger.getBoundingClientRect(),
      layoutHeight: environment.layoutHeight(),
      visualTop: viewport?.offsetTop ?? 0,
      visualHeight: viewport?.height ?? environment.layoutHeight(),
    });
    elements.dialog.dataset.presentation = geometry.presentation;
    elements.dialog.style.setProperty("--chat-configuration-left", `${geometry.left}px`);
    elements.dialog.style.setProperty("--chat-configuration-width", `${geometry.width}px`);
    elements.dialog.style.setProperty("--chat-configuration-bottom", `${geometry.bottom}px`);
    elements.dialog.style.setProperty("--chat-configuration-max-height", `${geometry.maxHeight}px`);
  };

  const finishClose = (): void => {
    if (!open) return;
    open = false;
    elements.search.value = "";
    activeModelValue = "";
    elements.trigger.setAttribute("aria-expanded", "false");
    renderModels();
    if (elements.trigger.ownerDocument.body.contains(elements.trigger)) elements.trigger.focus();
  };

  const close = (): void => {
    if (!open) return;
    if (typeof elements.dialog.close === "function") elements.dialog.close();
    else {
      elements.dialog.removeAttribute("open");
      finishClose();
    }
  };

  const onDialogKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...elements.dialog.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])",
    )].filter(element => !element.hidden && !element.closest("[hidden]"));
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && elements.dialog.ownerDocument.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && elements.dialog.ownerDocument.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onSearchKeydown = (event: KeyboardEvent): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(event.key === "ArrowDown" ? 0 : selectableRows().length - 1);
    }
  };

  const onModelsKeydown = (event: KeyboardEvent): void => {
    const target = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-model-value]");
    if (!target || target.disabled) return;
    const rows = selectableRows();
    const index = rows.indexOf(target);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(index + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      target.click();
    }
  };

  const onCancel = (event: Event): void => {
    event.preventDefault();
    close();
  };
  const onBackdropClick = (event: MouseEvent): void => {
    if (event.target === elements.dialog) close();
  };
  const onSearch = (): void => { activeModelValue = ""; renderModels(); };
  const onMode = (): void => {
    const mode = selectedValue(elements.modeSelect);
    if (mode && !state.modes.some(candidate => candidate.name === mode)) return;
    state = { ...state, configuration: { ...state.configuration, mode } };
    callbacks.onMode(mode);
    renderFooter();
  };
  const onVariant = (): void => {
    const variant = selectedValue(elements.variantSelect);
    const model = state.configuration.model
      ? state.models.find(candidate => sameModel(candidate.selection, state.configuration.model))
      : state.models.find(candidate => candidate.default);
    if (variant && !model?.variants?.includes(variant)) return;
    state = { ...state, configuration: { ...state.configuration, variant } };
    callbacks.onVariant(variant);
    renderFooter();
  };

  elements.done.addEventListener("click", close);
  elements.dialog.addEventListener("close", finishClose);
  elements.dialog.addEventListener("cancel", onCancel);
  elements.dialog.addEventListener("click", onBackdropClick);
  elements.dialog.addEventListener("keydown", onDialogKeydown);
  elements.search.addEventListener("input", onSearch);
  elements.search.addEventListener("keydown", onSearchKeydown);
  elements.models.addEventListener("keydown", onModelsKeydown);
  elements.modeSelect?.addEventListener("change", onMode);
  elements.variantSelect?.addEventListener("change", onVariant);
  const viewport = environment.visualViewport();
  viewport?.addEventListener("resize", applyGeometry);
  viewport?.addEventListener("scroll", applyGeometry);
  environment.addResizeListener(applyGeometry);
  const releaseMode = environment.onModeChange(applyGeometry);

  renderModels();

  return {
    open: () => {
      if (open) return;
      open = true;
      elements.trigger.setAttribute("aria-expanded", "true");
      renderModels();
      applyGeometry();
      if (typeof elements.dialog.showModal === "function") elements.dialog.showModal();
      else elements.dialog.setAttribute("open", "");
      environment.defer(() => {
        if (!open) return;
        if (environment.mode() === "touch") (elements.touchInitialFocus ?? elements.done).focus();
        else elements.search.focus();
      });
    },
    close,
    update: nextState => {
      state = {
        ...nextState,
        configuration: { ...nextState.configuration },
      };
      renderModels();
      applyGeometry();
    },
    destroy: () => {
      close();
      elements.done.removeEventListener("click", close);
      elements.dialog.removeEventListener("close", finishClose);
      elements.dialog.removeEventListener("cancel", onCancel);
      elements.dialog.removeEventListener("click", onBackdropClick);
      elements.dialog.removeEventListener("keydown", onDialogKeydown);
      elements.search.removeEventListener("input", onSearch);
      elements.search.removeEventListener("keydown", onSearchKeydown);
      elements.models.removeEventListener("keydown", onModelsKeydown);
      elements.modeSelect?.removeEventListener("change", onMode);
      elements.variantSelect?.removeEventListener("change", onVariant);
      viewport?.removeEventListener("resize", applyGeometry);
      viewport?.removeEventListener("scroll", applyGeometry);
      environment.removeResizeListener(applyGeometry);
      releaseMode();
    },
  };
}
