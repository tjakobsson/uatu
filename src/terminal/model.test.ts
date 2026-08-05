import { describe, expect, test } from "bun:test";

import { TerminalModel } from "./model";

function activeLines(model: TerminalModel): string[] {
  const buffer = model.terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines;
}

async function restore(source: TerminalModel, cols: number, rows: number): Promise<TerminalModel> {
  await source.resize(cols, rows);
  const target = new TerminalModel(cols, rows);
  target.write(await source.serialize());
  await target.drain();
  return target;
}

describe("TerminalModel reconstruction", () => {
  test("preserves UTF-8 split at every byte boundary and normal scrollback", async () => {
    const encoded = new TextEncoder().encode("before\r\nwide: ─ 😀\r\nafter");
    for (let split = 1; split < encoded.length; split += 1) {
      const source = new TerminalModel(40, 4);
      source.write(encoded.slice(0, split));
      source.write(encoded.slice(split));
      const target = await restore(source, 40, 4);
      const text = activeLines(target).join("\n");
      expect(text).toContain("wide: ─ 😀");
      expect(text).not.toContain("�");
      source.dispose();
      target.dispose();
    }
  });

  test("restores alternate-buffer content and supported TUI modes", async () => {
    const source = new TerminalModel(30, 6);
    source.write(new TextEncoder().encode(
      "normal history\r\n\x1b[?1049h\x1b[?1h\x1b[?1000h\x1b[?2004h\x1b[2J\x1b[HTUI screen",
    ));
    const serialized = new TextDecoder().decode(await source.serialize());
    expect(serialized).toContain("\x1b[?1049h");
    expect(serialized).toContain("\x1b[?1h");
    expect(serialized).toContain("\x1b[?1000h");
    expect(serialized).toContain("\x1b[?2004h");

    const target = await restore(source, 30, 6);
    expect(target.terminal.buffer.active.type).toBe("alternate");
    expect(activeLines(target).join("\n")).toContain("TUI screen");
    source.dispose();
    target.dispose();
  });

  test("restores private TUI modes omitted by the xterm serializer across chunks", async () => {
    const source = new TerminalModel(30, 6);
    const output = new TextEncoder().encode("\x1b[?25l\x1b[3 q\x1b[?1000;1006h");
    source.write(output.slice(0, 5));
    source.write(output.slice(5, 17));
    source.write(output.slice(17));
    const serialized = new TextDecoder().decode(await source.serialize());
    expect(serialized).toContain("\x1b[?25l");
    expect(serialized).toContain("\x1b[3 q");
    expect(serialized).toContain("\x1b[?1006h");
    source.dispose();
  });

  test("reconstructs after resizing from a large to a small grid", async () => {
    const source = new TerminalModel(120, 40);
    source.write(new TextEncoder().encode("line one\r\nline two\r\nline three"));
    const target = await restore(source, 40, 8);
    expect(target.terminal.cols).toBe(40);
    expect(target.terminal.rows).toBe(8);
    expect(activeLines(target).join("\n")).toContain("line three");
    source.dispose();
    target.dispose();
  });
});
