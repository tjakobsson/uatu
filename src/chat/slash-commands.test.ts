import { describe, expect, test } from "bun:test";

import type { ChatProvider } from "./provider";
import type { ChatCommand } from "./types";
import { ChatAdapter, parseSlashCommand } from "./adapter";
import { insertCommand, localHistoryOperation, matchingCommands, slashCommandQuery } from "./slash-commands";

const commands: ChatCommand[] = [
  { name: "review", description: "Review work", argumentHint: "[focus]", kind: "command" },
  { name: "openspec-apply", description: "Apply a change", argumentHint: "<change>", kind: "skill" },
  { name: "compact", description: "Compact context", argumentHint: "", kind: "command" },
];

describe("slash command completion", () => {
  test("finds the slash token at the caret, including after prose", () => {
    expect(slashCommandQuery("check this /open", 16)).toEqual({ start: 11, end: 16, query: "open" });
    expect(slashCommandQuery("/review later", 13)).toBeNull();
    expect(slashCommandQuery("path/to", 7)).toBeNull();
  });

  test("sorts an empty query alphabetically and matches prefixes", () => {
    expect(matchingCommands("/", 1, commands)?.commands.map(command => command.name))
      .toEqual(["compact", "openspec-apply", "review"]);
    expect(matchingCommands("/op", 3, commands)?.commands.map(command => command.name)).toEqual(["openspec-apply", "compact"]);
  });

  test("ranks fuzzy matches by match type and excludes unrelated commands", () => {
    const fuzzyCommands: ChatCommand[] = [
      { name: "a-r-c", description: "Subsequence", argumentHint: "", kind: "command" },
      { name: "monarch", description: "Substring", argumentHint: "", kind: "command" },
      { name: "openspec-archive-change", description: "Segment", argumentHint: "", kind: "command" },
      { name: "archive", description: "Exact", argumentHint: "", kind: "command" },
      { name: "archives", description: "Prefix", argumentHint: "", kind: "command" },
      { name: "review", description: "Unrelated", argumentHint: "", kind: "command" },
    ];

    expect(matchingCommands("/ArC", 4, fuzzyCommands)?.commands.map(command => command.name)).toEqual([
      "archive",
      "archives",
      "openspec-archive-change",
      "monarch",
      "a-r-c",
    ]);
    expect(matchingCommands("/archive", 8, fuzzyCommands)?.commands.map(command => command.name)).toContain("openspec-archive-change");
  });

  test("uses match position, subsequence gaps, and names as deterministic tie-breakers", () => {
    const names = ["a-long-arc", "z-arc", "aaaarc", "zarc", "xazbcy", "azbcy", "alpha", "Alpha"];
    const tieCommands = names.map(name => ({ name, description: "", argumentHint: "", kind: "command" as const }));

    expect(matchingCommands("/arc", 4, tieCommands)?.commands.map(command => command.name)).toEqual([
      "z-arc",
      "a-long-arc",
      "zarc",
      "aaaarc",
    ]);
    expect(matchingCommands("/abc", 4, tieCommands)?.commands.map(command => command.name)).toEqual(["azbcy", "xazbcy"]);
    expect(matchingCommands("/", 1, tieCommands.slice(-2))?.commands.map(command => command.name)).toEqual(["Alpha", "alpha"]);
  });

  test("replaces only the active token and leaves room for arguments", () => {
    const query = slashCommandQuery("before /op after", 10)!;
    expect(insertCommand("before /op after", query, commands[1]!)).toEqual({ value: "before /openspec-apply  after", caret: 23 });
  });

  test("local operations are listed but never parsed as provider commands", () => {
    const local: ChatCommand[] = [
      { name: "undo", description: "Undo the latest user turn", argumentHint: "", kind: "local-operation" },
      { name: "redo", description: "Redo the next hidden user turn", argumentHint: "", kind: "local-operation" },
    ];
    expect(matchingCommands("/", 1, [...commands, ...local])?.commands.map(command => command.name))
      .toEqual(["compact", "openspec-apply", "redo", "review", "undo"]);
    expect(parseSlashCommand("/undo", local)).toBeUndefined();
    expect(parseSlashCommand("/redo", local)).toBeUndefined();
    expect(parseSlashCommand("/undo", [{ ...local[0]!, kind: "command" }])).toBeUndefined();
    expect(localHistoryOperation("/undo", local)).toBe("undo");
    expect(localHistoryOperation("/redo", local)).toBe("redo");
    expect(insertCommand("/un", slashCommandQuery("/un", 3)!, local[0]!)).toEqual({ value: "/undo", caret: 5 });
    for (const value of [" /undo", "/undo ", "/undo now", "/Undo", "before /undo", "/redo\n"]) {
      expect(localHistoryOperation(value, local)).toBeNull();
    }
    expect(localHistoryOperation("/undo", commands)).toBeNull();
    expect(localHistoryOperation("/undo", [{ ...local[0]!, kind: "command" }])).toBeNull();
    expect(localHistoryOperation("/undo", [], true)).toBe("undo");
    expect(localHistoryOperation("/redo", [], true)).toBe("redo");
    expect(localHistoryOperation("/undo now", [], true)).toBeNull();
  });

  test("appends local operations without disturbing provider order and gates them on complete operations", async () => {
    let providerCommandCalls = 0;
    const provider = {
      describe: () => ({ id: "test", name: "Test", capabilities: ["commands", "reversible-history"] }),
      listCommands: async () => commands,
      getReversibleHistoryState: async () => ({ staged: false, canUndo: true, canRedo: false, revertedMessages: [] }),
      undo: async () => ({ outcome: "nothing-to-undo", state: { staged: false, canUndo: false, canRedo: false, revertedMessages: [] } }),
      redo: async () => ({ outcome: "nothing-to-redo", state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] } }),
      revert: async () => ({ outcome: "changed", state: { staged: true, canUndo: false, canRedo: true, revertedMessages: [{ id: "message:user", text: "prompt" }] } }),
      restore: async () => ({ outcome: "changed", state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] } }),
      command: async () => { providerCommandCalls += 1; return { messageId: "unexpected" }; },
    } as unknown as ChatProvider;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd() });
    const listed = await adapter.commands();

    expect(listed.map(command => [command.name, command.kind])).toEqual([
      ["review", "command"],
      ["openspec-apply", "skill"],
      ["compact", "command"],
      ["undo", "local-operation"],
      ["redo", "local-operation"],
    ]);
    expect(parseSlashCommand("/undo", listed)).toBeUndefined();
    expect(parseSlashCommand("/redo", listed)).toBeUndefined();
    expect(providerCommandCalls).toBe(0);

    const incomplete = { ...provider, redo: undefined } as unknown as ChatProvider;
    const gated = new ChatAdapter({ provider: incomplete, workspacePath: process.cwd() });
    expect(gated.agent().capabilities).not.toContain("reversible-history");
    expect((await gated.commands()).map(command => command.name)).toEqual(commands.map(command => command.name));
  });
});
