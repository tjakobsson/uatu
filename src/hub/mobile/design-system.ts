/** Stateless mobile Hub markup. `body` is trusted product-composed HTML, never
 * user input. Legacy field `attrs` is developer-owned attribute markup only;
 * callers must escape interpolated values. Text and keys are escaped here.
 * Event binding, draft changes, focus and lifecycle belong to the view owners. */
import { escapeHtml as esc } from "../../shared/html";
import { mobileHubIcon as icon, type MobileHubIcon } from "./icons";

export const text = (value: string) => `<p class="mh-note">${esc(value)}</p>`;
export const action = (key: string, label: string, destructive = false) => `<button type="button" data-flow="${esc(key)}" class="mh-text-action${destructive ? " mh-destructive" : ""}">${esc(label)}</button>`;
export const group = (title: string, body: string, count?: number) => `<section class="mh-section"><h2>${esc(title)}${count === undefined ? "" : `<span>${esc(String(count))}</span>`}</h2><div class="mh-group">${body}</div></section>`;
export const field = (name: string, label: string, value = "", type = "text", attrs = "") => `<label class="mh-field">${esc(label)}<input name="${esc(name)}" type="${esc(type)}" value="${esc(value)}" ${attrs}/></label>`;
export const check = (name: string, label: string, checked = false, value = "on") => `<label class="mh-check mh-switch"><input type="checkbox" role="switch" name="${esc(name)}" value="${esc(value)}" ${checked ? "checked" : ""}/><span>${esc(label)}</span></label>`;
export const select = (name: string, label: string, options: Array<{ value: string; label: string; disabled?: boolean }>, value = "") => `<label class="mh-field">${esc(label)}<select name="${esc(name)}">${options.map(o => `<option value="${esc(o.value)}" ${o.value === value ? "selected" : ""} ${o.disabled ? "disabled" : ""}>${esc(o.label)}</option>`).join("")}</select></label>`;
/** Object navigation only. Keep relevant commands visible via action(), not a hidden More menu. */
export const listRow = (key: string, label: string, subtitle = "", iconName: MobileHubIcon = "folder") => `<div class="mh-list-row"><button type="button" class="mh-list-primary" data-flow="${esc(key)}" aria-label="${esc(label + (subtitle ? `, ${subtitle}` : ""))}">${icon(iconName)}<span class="mh-list-copy"><strong>${esc(label)}</strong>${subtitle ? `<small>${esc(subtitle)}</small>` : ""}</span>${icon("chevron")}</button></div>`;

export type SettingsTint = "gray" | "green" | "blue" | "purple";
/** Settings navigation, never an immediate mutation. */
export function destinationRow(key: string, label: string, symbol: MobileHubIcon, subtitle = "", value = "", tint: SettingsTint = "gray", credentialId?: string): string {
  return `<button type="button" class="mh-destination" data-action="${esc(key)}"${credentialId === undefined ? "" : ` data-credential-id="${esc(credentialId)}"`}><span class="mh-tile mh-${esc(tint)}">${icon(symbol)}</span><span class="mh-row-copy">${esc(label)}${subtitle ? `<small>${esc(subtitle)}</small>` : ""}</span><span class="mh-value">${esc(value)}</span>${icon("chevron")}</button>`;
}
/** Native one-of-many drafts; rendering never saves or changes preferences. */
export function choiceGroup(name: string, label: string, selected: string, options: Array<[string, string]>): string {
  return `<fieldset class="mh-preference-choices"><legend>${esc(label)}</legend><div class="mh-group">${options.map(([value, title]) => `<label class="mh-check"><input type="radio" name="${esc(name)}" data-pref="${esc(name)}" value="${esc(value)}" ${value === selected ? "checked" : ""}/><span>${esc(title)}</span></label>`).join("")}</div></fieldset>`;
}
export interface InfoRow {
  label: string;
  value: string;
  detail?: string;
  tone?: "neutral" | "positive" | "warning";
  mono?: boolean;
}
/** Read-only facts, deliberately separate from labeled draft controls. */
export function infoRows(rows: readonly InfoRow[]): string {
  return `<dl class="mh-info">${rows.map(row => `<div class="mh-info-row mh-info-${esc(row.tone ?? "neutral")}"><dt>${esc(row.label)}</dt><dd><span class="mh-info-value${row.mono ? " mh-info-mono" : ""}">${esc(row.value)}</span>${row.detail ? `<small class="mh-info-detail">${esc(row.detail)}</small>` : ""}</dd></div>`).join("")}</dl>`;
}
