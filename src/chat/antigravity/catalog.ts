import type { ChatMode, ChatModel, ConversationConfiguration } from "../types";
import { ANTIGRAVITY_PROVIDER_ID, configurationFromOptions } from "./normalization";

type RecordValue = Record<string, unknown>;

// The thinking levels agy's legacy model ids end in, in picker order.
const LEVELS = ["minimal", "low", "medium", "high", "xhigh"];

export type AcpCatalog = {
  models: ChatModel[];
  modes: ChatMode[];
  // How a model and thinking level are applied: through config options, or
  // (when agy offers only legacy model ids) by selecting the legacy id.
  selection: "config" | "legacy";
  legacyIds: string[];
  // What the answering session runs: agy's default for a new or loaded one.
  current: ConversationConfiguration;
};

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function options(configOptions: unknown, id: string): Array<{ value: string; name: string }> {
  if (!Array.isArray(configOptions)) return [];
  const option = configOptions.map(record).find(candidate => candidate?.id === id || candidate?.category === id);
  return Array.isArray(option?.options) ? option.options.flatMap(entry => {
    const value = record(entry);
    return typeof value?.value === "string" ? [{ value: value.value, name: typeof value.name === "string" ? value.name : value.value }] : [];
  }) : [];
}

/**
 * The model picker from a `session/new` or `session/load` answer (D7). The
 * model family option gives the models; the legacy ids that extend a family
 * with a level suffix (`gemini-4-neon-low`) give its thinking levels. With
 * no config options, legacy ids that share a family are folded the same way.
 */
export function catalogFromSession(answer: unknown, imageInput: boolean, known: (id: string) => boolean = () => false): AcpCatalog {
  const value = record(answer);
  const legacy = (Array.isArray(record(value?.models)?.availableModels) ? record(value?.models)!.availableModels as unknown[] : [])
    .flatMap(entry => {
      const model = record(entry);
      return typeof model?.modelId === "string" ? [{ id: model.modelId, name: typeof model.name === "string" ? model.name : model.modelId }] : [];
    });
  const current = configurationFromOptions(value?.configOptions);
  const levelNames = new Set([...LEVELS, ...options(value?.configOptions, "thought_level").map(option => option.value)]);
  const levelOf = (id: string, family: string) => id.startsWith(`${family}-`) && levelNames.has(id.slice(family.length + 1)) ? id.slice(family.length + 1) : undefined;
  let families = options(value?.configOptions, "model");
  const selection: AcpCatalog["selection"] = families.length ? "config" : "legacy";
  if (families.length === 0) {
    const seen = new Map<string, string>();
    // A level suffix makes a family only for an id that is not a model of its
    // own (a known or priced id such as `gpt-oss-120b-medium`) and that
    // shares the family with another level.
    const prefix = (id: string) => { const match = id.match(/^(.+)-([a-z]+)$/); return match && levelNames.has(match[2]!) ? match[1]! : undefined; };
    for (const model of legacy) {
      const candidate = prefix(model.id);
      const folds = candidate !== undefined && !known(model.id) && legacy.some(other => other.id !== model.id && prefix(other.id) === candidate && !known(other.id));
      const family = folds ? candidate : model.id;
      if (!seen.has(family)) seen.set(family, family === model.id ? model.name : model.name.replace(/\s*\([^)]*\)$/, ""));
    }
    families = [...seen].map(([family, name]) => ({ value: family, name }));
    const currentId = typeof record(value?.models)?.currentModelId === "string" ? record(value?.models)!.currentModelId as string : undefined;
    const family = currentId && (families.find(candidate => candidate.value === currentId) ?? families.find(candidate => levelOf(currentId, candidate.value)));
    if (family) {
      current.model = { providerId: ANTIGRAVITY_PROVIDER_ID, modelId: family.value };
      const level = levelOf(currentId!, family.value);
      if (level) current.variant = level;
    }
  }
  const order = (level: string) => { const index = LEVELS.indexOf(level); return index < 0 ? LEVELS.length : index; };
  // Without legacy ids, the thinking levels config options advertise belong
  // to the model they are current for.
  const advertised = options(value?.configOptions, "thought_level").map(option => option.value);
  const models: ChatModel[] = families.map(family => {
    const fromLegacy = legacy.flatMap(model => { const level = levelOf(model.id, family.value); return level ? [level] : []; });
    const variants = (fromLegacy.length || legacy.length ? fromLegacy : family.value === current.model?.modelId ? advertised : [])
      .sort((a, b) => order(a) - order(b));
    return {
      selection: { providerId: ANTIGRAVITY_PROVIDER_ID, modelId: family.value },
      provider: "Antigravity",
      name: family.name,
      ...(variants.length ? { variants } : {}),
      ...(imageInput ? { imageInput: true } : {}),
      ...(current.model?.modelId === family.value ? { default: true } : {}),
    };
  });
  const modes = record(value?.modes);
  const currentMode = typeof modes?.currentModeId === "string" ? modes.currentModeId : undefined;
  return {
    models,
    selection,
    legacyIds: legacy.map(model => model.id),
    modes: (Array.isArray(modes?.availableModes) ? modes.availableModes : []).flatMap(entry => {
      const mode = record(entry);
      return typeof mode?.id === "string" ? [{ name: mode.id, description: typeof mode.description === "string" ? mode.description : typeof mode.name === "string" ? mode.name : mode.id, ...(mode.id === currentMode ? { default: true } : {}) }] : [];
    }),
    current: { ...current, ...(currentMode && !current.mode ? { mode: currentMode } : {}) },
  };
}

/** The thinking level to apply for a selection: the chosen one when the model offers it. */
export function variantFor(catalog: AcpCatalog | undefined, modelId: string, variant: string | undefined): string | undefined {
  const model = catalog?.models.find(candidate => candidate.selection.modelId === modelId);
  return variant && model?.variants?.includes(variant) ? variant : undefined;
}

/** The legacy model id that selects a family at a thinking level, when agy offers one. */
export function legacyModelId(catalog: AcpCatalog, modelId: string, variant: string | undefined): string | undefined {
  const ids = new Set(catalog.legacyIds);
  if (variant && ids.has(`${modelId}-${variant}`)) return `${modelId}-${variant}`;
  if (ids.has(modelId)) return modelId;
  return catalog.legacyIds.find(id => id.startsWith(`${modelId}-`));
}
