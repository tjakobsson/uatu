// Regression tests for the PTY adapter's byte fidelity.
//
// The bug these tests guard against: any UTF-8 decode/re-encode round-trip
// in the PTY → listener path corrupts multi-byte codepoints whenever a
// kernel `read()` boundary lands mid-codepoint. The visible symptom in
// the embedded terminal was U+FFFD ("diamonds") clusters at chunk seams
// when TUIs emit dense runs of box-drawing characters.
//
// Approach: spawn a real shell via `spawnPty`, have it emit a known dense
// multi-byte stream (`─` U+2500 = bytes E2 94 80), capture every chunk
// delivered to the data listener, and assert the concatenated bytes
// contain exactly the expected number of codepoint triplets and zero
// U+FFFD encodings (`EF BF BD`).

import { describe, expect, it } from "bun:test";

import { spawnPty } from "./terminal-pty";
import { resolveTerminalBackend } from "./terminal-backend";

// Skip the suite when the Bun PTY backend isn't available (e.g., Windows
// or older Bun). Matches the pattern used in `terminal-server.test.ts`.
const backendOk = (await resolveTerminalBackend()).available;

// Run a shell via the PTY adapter, collect every Uint8Array delivered to
// the data listener, and resolve when the shell exits.
async function runAndCollect(shellCommand: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const pty = spawnPty("/bin/sh", ["-c", shellCommand], {
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  });
  pty.onData(bytes => {
    // Copy because Bun reuses its read buffer across callbacks.
    chunks.push(new Uint8Array(bytes));
  });
  await new Promise<void>(resolve => {
    pty.onExit(() => resolve());
  });
  // Allow any post-exit data callbacks to flush. Bun closes the master fd
  // shortly after the child exits; a single tick is enough in practice.
  await new Promise(r => setTimeout(r, 50));
  let total = 0;
  for (const c of chunks) total += c.length;
  const flat = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    flat.set(c, off);
    off += c.length;
  }
  return flat;
}

function countTriplet(buf: Uint8Array, a: number, b: number, c: number): number {
  let n = 0;
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === a && buf[i + 1] === b && buf[i + 2] === c) {
      n++;
      i += 2;
    }
  }
  return n;
}

describe.skipIf(!backendOk)("spawnPty byte fidelity", () => {
  it("delivers dense U+2500 (E2 94 80) bytes verbatim across read() boundaries", async () => {
    // 2200 copies of `─` = 6600 bytes — comfortably exceeds any single
    // read() chunk size on Linux/macOS PTY masters (typically 4-16 KiB),
    // guaranteeing several chunk boundaries within the stream.
    const N = 2200;
    const flat = await runAndCollect(
      // printf in /bin/sh is portable; the \xe2\x94\x80 escape emits the
      // exact UTF-8 bytes for U+2500 without any shell-side decode.
      `printf '%.0s\\xe2\\x94\\x80' $(seq 1 ${N})`,
    );

    // The bug's signature: U+FFFD encoded as EF BF BD. Pre-fix this would
    // appear at every chunk seam where E2 94 80 was split.
    const replacementCount = countTriplet(flat, 0xef, 0xbf, 0xbd);
    expect(replacementCount).toBe(0);

    // Every codepoint emitted by the shell must arrive intact.
    const tripletCount = countTriplet(flat, 0xe2, 0x94, 0x80);
    expect(tripletCount).toBe(N);
  });

  it("isolates partial-codepoint state between concurrent PTY sessions", async () => {
    // Two parallel shells emit dense multi-byte streams of *different*
    // codepoints. If a shared/module-level UTF-8 decoder were ever
    // reintroduced, partial bytes from session A would corrupt the start
    // of a chunk in session B and vice versa — both streams would show
    // U+FFFD at the seam.
    //
    // Codepoint A: `─` U+2500 = E2 94 80
    // Codepoint B: `│` U+2502 = E2 94 82
    const N = 800;
    const [a, b] = await Promise.all([
      runAndCollect(`printf '%.0s\\xe2\\x94\\x80' $(seq 1 ${N})`),
      runAndCollect(`printf '%.0s\\xe2\\x94\\x82' $(seq 1 ${N})`),
    ]);

    expect(countTriplet(a, 0xef, 0xbf, 0xbd)).toBe(0);
    expect(countTriplet(b, 0xef, 0xbf, 0xbd)).toBe(0);
    expect(countTriplet(a, 0xe2, 0x94, 0x80)).toBe(N);
    expect(countTriplet(b, 0xe2, 0x94, 0x82)).toBe(N);
    // Cross-contamination check: session A must contain none of B's
    // codepoint and vice versa.
    expect(countTriplet(a, 0xe2, 0x94, 0x82)).toBe(0);
    expect(countTriplet(b, 0xe2, 0x94, 0x80)).toBe(0);
  });
});
