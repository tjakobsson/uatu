import { describe, expect, test } from "bun:test";

import { renderTerminalText, tailStart, terminalLinesToHtml, terminalTextToHtml, TerminalOutputBuffer, TerminalTextParser } from "./ansi";

const ESC = "\x1b";

describe("incremental terminal text", () => {
  const fixtures = [
    "", "one\n\ntwo\r\n", "123456\rab\bX\tY",
    `${ESC}[1;2;3;4;7;9;31;44mstyled\nnext${ESC}[22;23;24;27;29;39;49mplain`,
    `${ESC}[38;5;196mred${ESC}[48;2;10;20;30mbg${ESC}[38:2::1:2:3mcolon${ESC}[m`,
    `first\nDownloading  10%\rDownloading 100%\r${ESC}[Kdone\n`,
    `abc\r${ESC}[41m${ESC}[Kz${ESC}[2KQ${ESC}[1Kx`,
    `a界\b${ESC}[Kz\n日本x\rA\n界\r${ESC}[1Kxy`,
    "e\u0301x\rA\n👩‍💻x\rA\n👍🏽x\rAB\n☑️x\rA\n🇺🇸x\rA",
    "\u0301x\n🇺🇸🇨🇦\n👨‍👩‍👧‍👦\nक्‍ष\n1️⃣\n\ud83dX\udc00",
    `${ESC}]8;;javascript:alert(1)${ESC}\\<script>&\"'${ESC}]8;;${ESC}\\`,
    `before${ESC}Psecret\x07still secret${ESC}${ESC}\\after${ESC}_hidden\x18shown`,
    `${ESC}^hidden${ESC}\\${ESC}Xhidden\x1ashown${ESC}]title\x07ok`,
    `a${ESC}[31\x18b${ESC}[31${ESC}[32mc${ESC}[12\u009b0md`,
    `\u009b31mred\u009dtitle\u009cplain\u0090payload\u009cend\u0085`,
    `a${ESC}%Gb${ESC}*Bc${ESC}(Bd${ESC}7e\x00\x7f`,
    `tail${ESC}`, `tail${ESC}[38;2;1`, `tail${ESC}]hidden`, `tail${ESC}(`,
  ];

  test("every UTF-16 split and every single-unit feed matches one-shot lines and safe HTML", () => {
    for (const input of fixtures) {
      const expected = renderTerminalText(input);
      for (let split = 0; split <= input.length; split += 1) {
        const parser = new TerminalTextParser();
        expect(parser.feed(input.slice(0, split)).lines).toEqual(renderTerminalText(input.slice(0, split)));
        const result = parser.feed(input.slice(split));
        expect(result.lines).toEqual(expected);
        expect(terminalLinesToHtml(result.lines)).toBe(terminalTextToHtml(input));
        expect(terminalLinesToHtml(result.lines)).not.toMatch(/<(?!\/?span[ >])/);
      }
      const parser = new TerminalTextParser();
      for (let at = 0; at < input.length; at += 1) {
        expect(parser.feed(input[at]!).lines).toEqual(renderTerminalText(input.slice(0, at + 1)));
      }
    }
  });

  test("provisional grapheme widths do not destroy overwritten cells", () => {
    const parser = new TerminalTextParser();
    parser.feed("abcd\r☑");
    expect(terminalLinesToHtml(parser.feed("️").lines)).toBe("☑️cd");
    expect(terminalLinesToHtml(parser.feed("X").lines)).toBe("☑️Xd");
    const joined = new TerminalTextParser();
    joined.feed("123456\r👩‍");
    joined.feed("\ud83d");
    expect(terminalLinesToHtml(joined.feed("\udcbbX").lines)).toBe("👩‍💻X456");
  });

  test("dirty ranges preserve unchanged lines, including controls and newline-only appends", () => {
    const parser = new TerminalTextParser();
    const first = parser.feed("fixed\nprogress");
    const fixed = first.lines[0];
    const progress = first.lines[1];
    expect(first.dirtyFrom).toBe(0);
    expect(parser.feed(`${ESC}[31m`).dirtyFrom).toBe(2);
    expect(parser.feed("\r").dirtyFrom).toBe(2);
    const rewrite = parser.feed("done");
    expect(rewrite.dirtyFrom).toBe(1);
    expect(rewrite.lines[0]).toBe(fixed);
    expect(progress).toEqual([{ text: "progress", style: {} }]);
    expect(parser.feed("\n").dirtyFrom).toBe(2);
    expect(parser.feed("").dirtyFrom).toBe(3);
  });

  test("cumulative snapshots reset on corrections, shortening, and empty replacements", () => {
    const buffer = new TerminalOutputBuffer();
    let previous = "";
    const snapshots = ["one\ntwo", "one\ntwo!", "one\nTWO!", "one", "", `${ESC}[31mred${ESC}]secret`, "plain", "plain\n", "plain\n"];
    for (const [at, output] of snapshots.entries()) {
      const result = buffer.update(output);
      const reset = at === 0 || !output.startsWith(previous);
      expect(result.reset).toBe(reset);
      expect(result.lines).toEqual(renderTerminalText(output));
      if (reset) expect(result.dirtyFrom).toBe(0);
      previous = output;
    }
    const work = buffer.stats;
    buffer.update(previous);
    expect(buffer.stats).toEqual(work);
  });

  test("long cumulative logs parse suffixes with linear work and retain the first line", () => {
    const buffer = new TerminalOutputBuffer();
    let output = "earliest\n";
    const first = buffer.update(output).lines[0];
    const updates = 2000;
    for (let at = 0; at < updates; at += 1) {
      output += `${ESC}[32mline ${at}${ESC}[0m\n`;
      const result = buffer.update(output);
      expect(result.reset).toBe(false);
      expect(result.dirtyFrom).toBe(at + 1);
      expect(result.lines[0]).toBe(first);
      expect(result.lines.length).toBe(at + 3);
    }
    expect(buffer.stats.inputCodeUnits).toBe(output.length);
    expect(buffer.stats.segmentedCodeUnits).toBeLessThan(output.length * 3);
    expect(buffer.stats.renderedCells).toBeLessThan(output.length);
    expect(buffer.stats.prefixCodeUnits).toBeGreaterThan(output.length * 100);
    expect(buffer.stats.resets).toBe(1);
    expect(buffer.update(output).lines).toEqual(renderTerminalText(output));
  });

  test("unterminated hostile control payloads are consumed once without rendering work", () => {
    const parser = new TerminalTextParser();
    parser.feed(`visible${ESC}]`);
    const before = parser.stats;
    for (let at = 0; at < 1000; at += 1) {
      const result = parser.feed("<script>hidden</script>\n");
      expect(result.dirtyFrom).toBe(1);
    }
    expect(parser.stats.inputCodeUnits - before.inputCodeUnits).toBe(1000 * "<script>hidden</script>\n".length);
    expect(parser.stats.segmentedCodeUnits).toBe(before.segmentedCodeUnits);
    expect(parser.stats.renderedCells).toBe(before.renderedCells);
    expect(terminalLinesToHtml(parser.feed(`${ESC}\\<b>shown</b>`).lines)).toBe("visible&lt;b&gt;shown&lt;/b&gt;");
  });
});

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
    // Cells right of the cursor are painted too, not dropped.
    expect(renderTerminalText(`abc\r${ESC}[41m${ESC}[2K`)[0]).toEqual([{ text: "   ", style: { bg: 1 } }]);
    expect(renderTerminalText(`abc\r${ESC}[41m${ESC}[2Kz`)[0]).toEqual([{ text: "z  ", style: { bg: 1 } }]);
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
    // 8-bit C1 forms read as their ESC spellings; DEL and other C1 controls go.
    expect(renderTerminalText("\u009b31mred\u009b0m \u009d0;title\u009c ok\u007f \u0085x").map(line => line.map(run => run.text).join(""))).toEqual(["red  ok x"]);
    expect(renderTerminalText("\u009b32mgreen\u009bm")[0]).toEqual([{ text: "green", style: { fg: 2 } }]);
    // BEL ends only OSC; inside DCS and kin it is payload, and so is what
    // follows it up to ST. Other ESC sequences consume their intermediates.
    expect(renderTerminalText(`before${ESC}Pabc\x07secret${ESC}\\after`).map(line => line.map(run => run.text).join(""))).toEqual(["beforeafter"]);
    expect(renderTerminalText(`a${ESC}%Gb${ESC}*Bc${ESC}(Bd${ESC}7e`).map(line => line.map(run => run.text).join(""))).toEqual(["abcde"]);
    // CAN or SUB cancels a CSI or a control string; a new ESC restarts a CSI.
    const plain = (input: string) => renderTerminalText(input).map(line => line.map(run => run.text).join(""));
    expect(plain(`before${ESC}[31\x18after`)).toEqual(["beforeafter"]);
    expect(renderTerminalText(`before${ESC}[31${ESC}[32mafter`)[0]).toEqual([{ text: "before", style: {} }, { text: "after", style: { fg: 2 } }]);
    expect(plain(`before${ESC}]0;title\x18after`)).toEqual(["beforeafter"]);
    expect(plain(`before${ESC}Pdata\x1aafter`)).toEqual(["beforeafter"]);
    // Control strings — DCS, APC, PM, SOS — go whole, payload included.
    expect(renderTerminalText(`before${ESC}P1;2|secret${ESC}\\after ${ESC}_apc${ESC}\\x ${ESC}^pm${ESC}\\y ${ESC}Xsos${ESC}\\z`).map(line => line.map(run => run.text).join(""))).toEqual(["beforeafter x y z"]);
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

describe("tailStart", () => {
  test("a cut inside a control string resumes after its terminator", () => {
    const text = `line one\n${ESC}]0;title with\na newline${"\x07"}line two\nline three`;
    const cut = text.indexOf("a newline");
    expect(text.slice(tailStart(text, cut))).toBe("line two\nline three");
    // Terminated before the cut, or no control string at all: the cut stands.
    expect(tailStart(`${ESC}]0;t${"\x07"}abc\ndef`, 8)).toBe(8);
    expect(tailStart("plain\ntext", 6)).toBe(6);
    // Unterminated so far (still streaming): nothing of the payload shows.
    const open = `${ESC}Ppayload\nmore`;
    expect(tailStart(open, open.indexOf("more"))).toBe(open.length);
    // A cancelled control string ends at the CAN.
    const cancelled = `${ESC}]0;a\nb\x18shown`;
    expect(cancelled.slice(tailStart(cancelled, cancelled.indexOf("b\x18")))).toBe("shown");
    // A BEL inside a DCS payload is not its end.
    const dcs = `${ESC}Pone\x07two\nthree${ESC}\\shown`;
    expect(dcs.slice(tailStart(dcs, dcs.indexOf("three")))).toBe("shown");
    // An 8-bit introducer and ST count too.
    const c1 = `\u009d0;a\nb\u009cvisible`;
    expect(text.length).toBeGreaterThan(0);
    expect(c1.slice(tailStart(c1, c1.indexOf("b\u009c")))).toBe("visible");
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
