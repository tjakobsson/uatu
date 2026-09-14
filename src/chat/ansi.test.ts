import { describe, expect, test } from "bun:test";

import { renderTerminalText, terminalLinesToHtml, terminalTextToHtml } from "./ansi";

const ESC = "\x1b";

describe("renderTerminalText", () => {
  test("styles runs by SGR and resets them", () => {
    const [line] = renderTerminalText(`plain ${ESC}[32mpass${ESC}[0m ${ESC}[1;31mFAIL${ESC}[m end`);
    expect(line).toEqual([
      { text: "plain ", style: {} },
      { text: "pass", style: { fg: 2 } },
      { text: " ", style: {} },
      { text: "FAIL", style: { fg: 1, bold: true } },
      { text: " end", style: {} },
    ]);
  });

  test("every attribute has a set and a clear", () => {
    const attrs = `${ESC}[1m${ESC}[2m${ESC}[3m${ESC}[4m${ESC}[7m${ESC}[9mx${ESC}[22m${ESC}[23m${ESC}[24m${ESC}[27m${ESC}[29my`;
    const [line] = renderTerminalText(attrs);
    expect(line).toEqual([
      { text: "x", style: { bold: true, dim: true, italic: true, underline: true, inverse: true, strike: true } },
      { text: "y", style: {} },
    ]);
  });

  test("bright, background, 256-colour and truecolour forms", () => {
    const [line] = renderTerminalText(`${ESC}[93ma${ESC}[44mb${ESC}[38;5;196mc${ESC}[48;5;244md${ESC}[38;2;10;20;30me${ESC}[38:2::1:2:3mf${ESC}[39;49mg`);
    expect(line).toEqual([
      { text: "a", style: { fg: 11 } },
      { text: "b", style: { fg: 11, bg: 4 } },
      { text: "c", style: { fg: "rgb(255,0,0)", bg: 4 } },
      { text: "d", style: { fg: "rgb(255,0,0)", bg: "rgb(128,128,128)" } },
      { text: "e", style: { fg: "rgb(10,20,30)", bg: "rgb(128,128,128)" } },
      { text: "f", style: { fg: "rgb(1,2,3)", bg: "rgb(128,128,128)" } },
      { text: "g", style: {} },
    ]);
    // 256-colour indexes inside the palette stay palette indexes.
    expect(renderTerminalText(`${ESC}[38;5;9mx`)[0]).toEqual([{ text: "x", style: { fg: 9 } }]);
  });

  test("a carriage return rewrites the line in place", () => {
    // A progress bar: the same columns redrawn many times, the last write wins.
    const text = "Downloading  10%\rDownloading  55%\rDownloading 100%\ndone";
    expect(renderTerminalText(text).map(line => line.map(run => run.text).join(""))).toEqual(["Downloading 100%", "done"]);
    // A shorter rewrite leaves the tail of the longer earlier line — as a
    // terminal does — unless the line is erased.
    expect(renderTerminalText("123456\rab").map(line => line.map(run => run.text).join(""))).toEqual(["ab3456"]);
    expect(renderTerminalText(`123456\r${ESC}[Kab`).map(line => line.map(run => run.text).join(""))).toEqual(["ab"]);
    expect(renderTerminalText(`123456\r${ESC}[2Kab`).map(line => line.map(run => run.text).join(""))).toEqual(["ab"]);
    expect(renderTerminalText(`123456\r12${ESC}[1Kab`).map(line => line.map(run => run.text).join(""))).toEqual(["  ab56"]);
    // Mode 1 includes the cell under the cursor.
    expect(renderTerminalText(`abc\r${ESC}[1K`).map(line => line.map(run => run.text).join(""))).toEqual([" bc"]);
    // A tab is cursor movement to the next stop, so an overwrite lands on
    // the cells a terminal would put it on; skipped cells keep their text.
    expect(renderTerminalText("a\tb\rxy").map(line => line.map(run => run.text).join(""))).toEqual(["xy      b"]);
    expect(renderTerminalText("abcdefghij\rX\tY").map(line => line.map(run => run.text).join(""))).toEqual(["XbcdefghYj"]);
    // Backspace steps back one cell; `\r\n` is one line break.
    expect(renderTerminalText("abc\b\bXY\r\nnext").map(line => line.map(run => run.text).join(""))).toEqual(["aXY", "next"]);
  });

  test("unknown sequences are dropped with the surrounding text intact", () => {
    const text = `${ESC}[2A${ESC}[?25lspin${ESC}[?25h ${ESC}]0;title${"\x07"}ok ${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\ ${ESC}(Bplain${ESC}=${ESC}7\x07\x00end`;
    expect(renderTerminalText(text).map(line => line.map(run => run.text).join(""))).toEqual(["spin ok link plainend"]);
    // A sequence cut off by the end of a streaming chunk is dropped, not shown.
    expect(renderTerminalText(`tail ${ESC}[3`).map(line => line.map(run => run.text).join(""))).toEqual(["tail "]);
  });

  test("a surrogate pair is one cell under an overwrite", () => {
    expect(renderTerminalText("🙂x\rY").map(line => line.map(run => run.text).join(""))).toEqual(["Yx"]);
  });
});

describe("terminalLinesToHtml", () => {
  test("emits palette classes, attribute classes, and numeric inline colours only", () => {
    const html = terminalTextToHtml(`${ESC}[1;32mpass${ESC}[0m ${ESC}[2;4mdim${ESC}[0m ${ESC}[38;2;1;2;3mtrue${ESC}[0m ${ESC}[7minv${ESC}[0m ${ESC}[7;31mred-inv`);
    expect(html).toBe(
      '<span class="ansi-fg-2 ansi-bold">pass</span> '
      + '<span class="ansi-dim ansi-underline">dim</span> '
      + '<span style="color:rgb(1,2,3)">true</span> '
      + '<span class="ansi-fg-default ansi-bg-default">inv</span> '
      + '<span class="ansi-fg-default ansi-bg-1">red-inv</span>',
    );
  });

  test("escapes cannot smuggle markup", () => {
    const html = terminalTextToHtml(`${ESC}[31m<script>alert(1)</script>${ESC}[0m <a href="javascript:alert(1)">x</a> "quoted" ${ESC}[38;2;1;2;3m'</span><b>'${ESC}[0m`);
    // The only element the output may contain is the styling span.
    expect(html).not.toMatch(/<(?!\/?span[ >])/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;quoted&quot;");
    // The only attributes are the fixed class set and a numeric rgb().
    const attributes = [...html.matchAll(/<span([^>]*)>/g)].map(match => match[1]!.trim());
    for (const attribute of attributes) {
      const classes = attribute.match(/class="([^"]*)"/)?.[1]?.split(" ") ?? [];
      const declarations = attribute.match(/style="([^"]*)"/)?.[1]?.split(";") ?? [];
      expect(attribute.replace(/class="[^"]*"/, "").replace(/style="[^"]*"/, "").trim()).toBe("");
      for (const name of classes) expect(name).toMatch(/^ansi-(fg-(\d{1,3}|default)|bg-(\d{1,3}|default)|bold|dim|italic|underline|strike)$/);
      for (const declaration of declarations) expect(declaration).toMatch(/^(color|background-color):rgb\(\d{1,3},\d{1,3},\d{1,3}\)$/);
    }
  });

  test("plain text is emitted bare, line by line", () => {
    expect(terminalLinesToHtml(renderTerminalText("a & b\nc"))).toBe("a &amp; b\nc");
  });
});
