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

function fuzzyRank(name: string, query: string): [number, number, number] | null {
  if (name === query) return [0, 0, 0];
  if (name.startsWith(query)) return [1, 0, 0];

  let position = name.indexOf(query, 1);
  while (position !== -1) {
    if (!/[a-z0-9]/i.test(name[position - 1]!)) return [2, position, 0];
    position = name.indexOf(query, position + 1);
  }

  position = name.indexOf(query);
  if (position !== -1) return [3, position, 0];

  let best: [number, number, number] | null = null;
  for (let start = name.indexOf(query[0]!); start !== -1; start = name.indexOf(query[0]!, start + 1)) {
    let end = start;
    for (let index = 1; index < query.length && end !== -1; index += 1) end = name.indexOf(query[index]!, end + 1);
    if (end === -1) continue;
    const rank: [number, number, number] = [4, end - start + 1 - query.length, start];
    if (!best || rank[1] < best[1] || (rank[1] === best[1] && rank[2] < best[2])) best = rank;
  }
  return best;
}

export function matchingCommands(value: string, caret: number, commands: ChatCommand[]): { query: SlashCommandQuery; commands: ChatCommand[] } | null {
  const query = slashCommandQuery(value, caret);
  if (!query) return null;
  const matches = commands.map((command, index) => ({ command, index, name: command.name.toLowerCase(), rank: query.query ? fuzzyRank(command.name.toLowerCase(), query.query) : [0, 0, 0] as [number, number, number] }))
    .filter((match): match is typeof match & { rank: [number, number, number] } => match.rank !== null)
    .sort((left, right) => left.rank[0] - right.rank[0]
      || left.rank[1] - right.rank[1]
      || left.rank[2] - right.rank[2]
      || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
      || (left.command.name < right.command.name ? -1 : left.command.name > right.command.name ? 1 : 0)
      || left.index - right.index)
    .map(match => match.command);
  return matches.length ? { query, commands: matches } : null;
}

export function insertCommand(value: string, query: SlashCommandQuery, command: ChatCommand): { value: string; caret: number } {
  const insertion = `/${command.name}${command.kind === "local-operation" ? "" : " "}`;
  const next = value.slice(0, query.start) + insertion + value.slice(query.end);
  return { value: next, caret: query.start + insertion.length };
}
