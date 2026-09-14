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

  test("colon subparameters stay with their parameter", () => {
    // `4:2` is an underline variant, not underline plus dim; `4:0` is off.
    expect(renderTerminalText(`${ESC}[4:2mx${ESC}[4:0my`)[0]).toEqual([{ text: "x", style: { underline: true } }, { text: "y", style: {} }]);
    // The colourspace slot of the six-item form is not a channel, and a
    // trailing zero channel is not a reset.
    expect(renderTerminalText(`${ESC}[38:2:0:255:0:0mx`)[0]).toEqual([{ text: "x", style: { fg: "rgb(255,0,0)" } }]);
    expect(renderTerminalText(`${ESC}[48:5:196mx`)[0]).toEqual([{ text: "x", style: { bg: "rgb(255,0,0)" } }]);
    // Subparameters on anything else are that parameter's own detail.
    expect(renderTerminalText(`${ESC}[1;58:5:9mx`)[0]).toEqual([{ text: "x", style: { bold: true } }]);
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
    // Erasing to the end keeps the cells that held text, blank under the
    // active background.
    expect(renderTerminalText(`abc\r${ESC}[41m${ESC}[K`)[0]).toEqual([{ text: "   ", style: { bg: 1 } }]);
    expect(renderTerminalText(`abc\r${ESC}[41m${ESC}[Kz`)[0]).toEqual([{ text: "z  ", style: { bg: 1 } }]);
    // Erasing the whole line leaves the cursor where it was, the cells up
    // to it blank under the active background.
    expect(renderTerminalText(`abc${ESC}[41m${ESC}[2Kz`)[0]).toEqual([{ text: "   z", style: { bg: 1 } }]);
    expect(renderTerminalText(`123456\r12${ESC}[1Kab`).map(line => line.map(run => run.text).join(""))).toEqual(["  ab56"]);
    // Erased cells take the active background, as a terminal fills them —
    // the cursor cell included, even one just past the stored cells.
    expect(renderTerminalText(`abc\r${ESC}[41m${ESC}[1K`)[0]).toEqual([{ text: " ", style: { bg: 1 } }, { text: "bc", style: {} }]);
    expect(renderTerminalText(`abc${ESC}[41m${ESC}[1K`)[0]).toEqual([{ text: "    ", style: { bg: 1 } }]);
    expect(renderTerminalText(`abc${ESC}[1K`).map(line => line.map(run => run.text).join(""))).toEqual(["   "]);
    // Mode 1 includes the cell under the cursor, and a wide glyph whole.
    expect(renderTerminalText(`abc\r${ESC}[1K`).map(line => line.map(run => run.text).join(""))).toEqual([" bc"]);
    expect(renderTerminalText(`界\r${ESC}[1Kxy`).map(line => line.map(run => run.text).join(""))).toEqual(["xy"]);
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
    // Control strings — DCS, APC, PM, SOS — go whole, payload included.
    expect(renderTerminalText(`before${ESC}P1;2|secret${ESC}\\after ${ESC}_apc\x07x ${ESC}^pm${ESC}\\y ${ESC}Xsos${ESC}\\z`).map(line => line.map(run => run.text).join(""))).toEqual(["beforeafter x y z"]);
    // A sequence cut off by the end of a streaming chunk is dropped, not shown.
    expect(renderTerminalText(`tail ${ESC}[3`).map(line => line.map(run => run.text).join(""))).toEqual(["tail "]);
  });

  test("cells follow terminal widths: combining marks ride the cell before, wide characters take two", () => {
    const text = (input: string) => renderTerminalText(input).map(line => line.map(run => run.text).join(""));
    // The accent occupies the same cell as its base, so the overwrite
    // replaces the accented letter whole.
    expect(text("e\u0301x\rA")).toEqual(["Ax"]);
    // A wide character is two cells: the overwrite lands two columns on,
    // and writing over either half blanks the glyph rather than leaving half.
    expect(text("日本x\rAB")).toEqual(["AB本x"]);
    expect(text("日本x\rA")).toEqual(["A 本x"]);
    expect(text("🙂x\rY")).toEqual(["Y x"]);
    expect(text("ab\r日")).toEqual(["日"]);
    // Erasing to the end from a wide glyph's second cell clears the glyph.
    // The glyph's first half is left blank, not removed: a blank line.
    expect(text(`界x\b\b${ESC}[K`)).toEqual([" "]);
    // Erase never moves the cursor: the next write lands where it stood.
    expect(text(`a界\b${ESC}[Kz`)).toEqual(["a z"]);
    // Overwriting a styled wide glyph clears its other cell's style too.
    expect(renderTerminalText(`${ESC}[41m界${ESC}[0m\rA`)[0]).toEqual([{ text: "A ", style: {} }]);
    // Emoji with a variation selector or joiner stays one glyph.
    expect(text("\u2705\ufe0f ok")).toEqual(["\u2705\ufe0f ok"]);
    // A joined or skin-toned emoji is one two-cell glyph, cleared whole by
    // a redraw rather than leaving its pieces behind.
    expect(text("👩‍💻x\rA")).toEqual(["A x"]);
    expect(text("👍🏽x\rAB")).toEqual(["ABx"]);
    expect(text("👩‍💻")).toEqual(["👩‍💻"]);
    // Wide symbols outside the CJK blocks, and a narrow symbol given emoji
    // presentation, take two cells as terminals draw them.
    expect(text("✅x\rA")).toEqual(["A x"]);
    expect(text("☑\ufe0fx\rA")).toEqual(["A x"]);
    expect(text("☑x\rA")).toEqual(["Ax"]);
    expect(text("🫠x\rA")).toEqual(["A x"]);
    // A flag is two regional indicators drawn as one two-cell glyph.
    expect(text("🇺🇸x\rA")).toEqual(["A x"]);
    // A combining mark with nothing before it stands on its own.
    expect(text("\u0301x")).toEqual(["\u0301x"]);
  });
});

describe("terminalLinesToHtml", () => {
  test("emits palette classes, attribute classes, and numeric inline colours only", () => {
    const html = terminalTextToHtml(`${ESC}[1;32mpass${ESC}[0m ${ESC}[2;4mdim${ESC}[0m ${ESC}[38;2;1;2;3mtrue${ESC}[0m ${ESC}[7minv${ESC}[0m ${ESC}[7;31mred-inv`);
    expect(html).toBe(
      '<span class="ansi-fg-2 ansi-bold">pass</span> '
      + '<span class="ansi-dim ansi-underline">dim</span> '
      + '<span class="ansi-fg-inline" style="--ansi-fg:rgb(1,2,3)">true</span> '
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
      for (const name of classes) expect(name).toMatch(/^ansi-(fg-(\d{1,3}|default|inline)|bg-(\d{1,3}|default|inline)|bold|dim|italic|underline|strike)$/);
      for (const declaration of declarations) expect(declaration).toMatch(/^--ansi-(fg|bg):rgb\(\d{1,3},\d{1,3},\d{1,3}\)$/);
    }
  });

  test("plain text is emitted bare, line by line", () => {
    expect(terminalLinesToHtml(renderTerminalText("a & b\nc"))).toBe("a &amp; b\nc");
  });
});
