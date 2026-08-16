import { describe, expect, test } from "bun:test";

import type { ChatCommand } from "./types";
import { insertCommand, matchingCommands, slashCommandQuery } from "./slash-commands";

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

  test("filters by prefix and sorts command names", () => {
    expect(matchingCommands("/", 1, commands)?.commands.map(command => command.name))
      .toEqual(["compact", "openspec-apply", "review"]);
    expect(matchingCommands("/op", 3, commands)?.commands.map(command => command.name)).toEqual(["openspec-apply"]);
  });

  test("replaces only the active token and leaves room for arguments", () => {
    const query = slashCommandQuery("before /op after", 10)!;
    expect(insertCommand("before /op after", query, commands[1]!)).toEqual({ value: "before /openspec-apply  after", caret: 23 });
  });
});
