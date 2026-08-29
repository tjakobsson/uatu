import type { ChatCommand } from "./types";

export type SlashCommandQuery = {
  start: number;
  end: number;
  query: string;
};

export type LocalHistoryOperation = "undo" | "redo";

export function localHistoryOperation(value: string, commands: ChatCommand[], reversibleHistory = false): LocalHistoryOperation | null {
  const name = value === "/undo" ? "undo" : value === "/redo" ? "redo" : null;
  if (!name) return null;
  return reversibleHistory || commands.some(command => command.name === name && command.kind === "local-operation") ? name : null;
}

export function slashCommandQuery(value: string, caret: number): SlashCommandQuery | null {
  const before = value.slice(0, caret);
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(before);
  if (!match) return null;
  const start = caret - match[1]!.length - 1;
  return { start, end: caret, query: match[1]!.toLowerCase() };
}

export function matchingCommands(value: string, caret: number, commands: ChatCommand[]): { query: SlashCommandQuery; commands: ChatCommand[] } | null {
  const query = slashCommandQuery(value, caret);
  if (!query) return null;
  const matches = commands
    .filter(command => command.name.toLowerCase().startsWith(query.query))
    .sort((left, right) => left.name.localeCompare(right.name));
  return matches.length ? { query, commands: matches } : null;
}

export function insertCommand(value: string, query: SlashCommandQuery, command: ChatCommand): { value: string; caret: number } {
  const insertion = `/${command.name}${command.kind === "local-operation" ? "" : " "}`;
  const next = value.slice(0, query.start) + insertion + value.slice(query.end);
  return { value: next, caret: query.start + insertion.length };
}
