/**
 * Normalizes each agent's login-method form description into the one field
 * model the Settings page renders (`AccountField`), and converts submitted
 * answers back into what each agent expects.
 *
 * Both OpenCode generations describe extra login fields, in different shapes:
 * 1.x `prompts` (`text` / `select`, one `when`) and 2.x `form` (typed fields,
 * a list of `when` conditions). Parsing is defensive. An agent may add prompt
 * types this code has never seen, and an unknown type becomes a plain text
 * field rather than hiding the method.
 */

import type { AccountField, AccountFieldCondition, AccountFieldOption } from "./agent-account-types";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function conditionValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function parseCondition(value: unknown): AccountFieldCondition | null {
  const raw = record(value);
  const key = text(raw?.key);
  const op = raw?.op === "neq" ? "neq" : raw?.op === "eq" ? "eq" : undefined;
  const expected = conditionValue(raw?.value);
  return key && op && expected !== undefined ? { key, op, value: expected } : null;
}

function parseConditions(value: unknown): AccountFieldCondition[] | undefined {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const conditions = list.map(parseCondition).filter((condition): condition is AccountFieldCondition => condition !== null);
  return conditions.length ? conditions : undefined;
}

function parseOptions(value: unknown): AccountFieldOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: AccountFieldOption[] = [];
  for (const item of value) {
    const raw = record(item);
    const optionValue = conditionValue(raw?.value);
    if (optionValue === undefined) continue;
    const hint = text(raw?.hint) ?? text(raw?.description);
    options.push({ value: optionValue, label: text(raw?.label) ?? optionValue, ...(hint ? { hint } : {}) });
  }
  return options.length ? options : undefined;
}

function withOptional(field: AccountField, extra: { placeholder?: string; description?: string; options?: AccountFieldOption[]; when?: AccountFieldCondition[] }): AccountField {
  return {
    ...field,
    ...(extra.placeholder ? { placeholder: extra.placeholder } : {}),
    ...(extra.description ? { description: extra.description } : {}),
    ...(extra.options ? { options: extra.options } : {}),
    ...(extra.when ? { when: extra.when } : {}),
  };
}

/**
 * OpenCode 1.x `prompts`. 1.x declares `text` and `select`; both are asked
 * before the method runs, and the server rejects an answer it needs and did
 * not get, so every prompt is required while it is shown.
 */
export function fieldsFromOpenCodeV1Prompts(prompts: unknown): AccountField[] {
  if (!Array.isArray(prompts)) return [];
  const fields: AccountField[] = [];
  for (const item of prompts) {
    const raw = record(item);
    const key = text(raw?.key);
    if (!key) continue;
    const options = raw?.type === "select" ? parseOptions(raw.options) : undefined;
    fields.push(withOptional(
      { key, label: text(raw?.message) ?? key, kind: options ? "select" : "text", valueType: "string", required: true },
      { placeholder: text(raw?.placeholder), options, when: parseConditions(raw?.when) },
    ));
  }
  return fields;
}

/**
 * OpenCode 2.x `form`. A string field with fixed options and no custom
 * entry is a select; a boolean is a yes/no select. Numbers and multiselects
 * are typed text, converted back on submit. An `external` field is a link to
 * visit rather than an answer, and `hidden` fields are never asked, so both
 * are dropped.
 */
export function fieldsFromOpenCodeV2Form(form: unknown): AccountField[] {
  if (!Array.isArray(form)) return [];
  const fields: AccountField[] = [];
  for (const item of form) {
    const raw = record(item);
    const key = text(raw?.key);
    if (!key || raw?.hidden === true || raw?.type === "external") continue;
    const label = text(raw?.title) ?? key;
    const required = raw?.required === true;
    const extra = { placeholder: text(raw?.placeholder), description: text(raw?.description), when: parseConditions(raw?.when) };
    if (raw?.type === "boolean") {
      fields.push(withOptional({ key, label, kind: "select", valueType: "boolean", required }, {
        ...extra,
        options: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }],
      }));
      continue;
    }
    if (raw?.type === "number" || raw?.type === "integer") {
      fields.push(withOptional({ key, label, kind: "text", valueType: "number", required }, extra));
      continue;
    }
    if (raw?.type === "multiselect") {
      fields.push(withOptional({ key, label, kind: "text", valueType: "list", required }, {
        ...extra,
        description: extra.description ?? "Separate several values with commas.",
      }));
      continue;
    }
    const options = raw?.custom === true ? undefined : parseOptions(raw?.options);
    fields.push(withOptional({ key, label, kind: options ? "select" : "text", valueType: "string", required }, { ...extra, options }));
  }
  return fields;
}

/** Whether a field is shown, given the answers so far. */
export function fieldVisible(field: AccountField, answers: Record<string, string>): boolean {
  return (field.when ?? []).every(condition => {
    const actual = answers[condition.key] ?? "";
    return condition.op === "eq" ? actual === condition.value : actual !== condition.value;
  });
}

export class AccountFieldError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "AccountFieldError";
  }
}

/**
 * The answers to hand an agent: only visible fields, each converted to its
 * `valueType`. A required visible field without an answer is an error naming
 * the field (never its value).
 */
export function collectAnswers(fields: AccountField[], submitted: Record<string, unknown>): Record<string, string | number | boolean | string[]> {
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(submitted)) if (typeof value === "string") strings[key] = value;
  const answers: Record<string, string | number | boolean | string[]> = {};
  for (const field of fields) {
    if (!fieldVisible(field, strings)) continue;
    const value = (strings[field.key] ?? "").trim();
    if (!value) {
      if (field.required) throw new AccountFieldError(field.key, `${field.label} is required.`);
      continue;
    }
    if (field.options && !field.options.some(option => option.value === value)) {
      throw new AccountFieldError(field.key, `${field.label} must be one of the listed choices.`);
    }
    switch (field.valueType) {
      case "number": {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new AccountFieldError(field.key, `${field.label} must be a number.`);
        answers[field.key] = number;
        break;
      }
      case "boolean":
        answers[field.key] = value === "true";
        break;
      case "list":
        answers[field.key] = value.split(",").map(part => part.trim()).filter(Boolean);
        break;
      default:
        answers[field.key] = value;
    }
  }
  return answers;
}

/** 1.x takes every answer as a string. */
export function stringAnswers(answers: Record<string, string | number | boolean | string[]>): Record<string, string> {
  return Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : String(value)]));
}
