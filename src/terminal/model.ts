import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { Terminal as BrowserTerminal } from "@xterm/xterm";

export const TERMINAL_SCROLLBACK = 5000;

export class TerminalModel {
  readonly terminal: HeadlessTerminal;
  private readonly serializer = new SerializeAddon();
  private readonly modeDecoder = new TextDecoder();
  private modeTail = "";
  private cursorVisible: boolean | undefined;
  private cursorStyle: string | undefined;
  private readonly mouseEncodings = new Map<string, boolean>();
  private writeQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(cols: number, rows: number) {
    this.terminal = new HeadlessTerminal({
      cols,
      rows,
      scrollback: TERMINAL_SCROLLBACK,
      allowProposedApi: true,
    });
    // SerializeAddon is runtime-compatible with headless xterm but publishes
    // browser-Terminal types. Keep the unavoidable cast at this boundary.
    this.serializer.activate(this.terminal as unknown as BrowserTerminal);
  }

  write(bytes: Uint8Array): void {
    const copy = new Uint8Array(bytes);
    this.trackUnserializedModes(copy);
    this.writeQueue = this.writeQueue.then(() => new Promise<void>(resolve => {
      this.terminal.write(copy, resolve);
    }));
  }

  async resize(cols: number, rows: number): Promise<void> {
    await this.drain();
    this.terminal.resize(cols, rows);
  }

  drain(): Promise<void> {
    return this.writeQueue;
  }

  async serialize(): Promise<Uint8Array> {
    await this.drain();
    const snapshot = this.serializer.serialize({
      scrollback: TERMINAL_SCROLLBACK,
      excludeAltBuffer: false,
      excludeModes: false,
    });
    return new TextEncoder().encode(snapshot + this.serializeModeLedger());
  }

  private trackUnserializedModes(bytes: Uint8Array): void {
    const text = this.modeTail + this.modeDecoder.decode(bytes, { stream: true });
    for (const match of text.matchAll(/\x1b\[\?([0-9;]+)([hl])/g)) {
      for (const mode of match[1]!.split(";")) {
        if (mode === "25") this.cursorVisible = match[2] === "h";
        if (mode === "1005" || mode === "1006" || mode === "1015") {
          this.mouseEncodings.set(mode, match[2] === "h");
        }
      }
    }
    for (const match of text.matchAll(/\x1b\[([0-9]*) q/g)) {
      this.cursorStyle = match[1] || "0";
    }
    this.modeTail = text.slice(-64);
  }

  private serializeModeLedger(): string {
    let result = "";
    if (this.cursorVisible !== undefined) result += `\x1b[?25${this.cursorVisible ? "h" : "l"}`;
    if (this.cursorStyle !== undefined) result += `\x1b[${this.cursorStyle} q`;
    for (const [mode, enabled] of this.mouseEncodings) {
      result += `\x1b[?${mode}${enabled ? "h" : "l"}`;
    }
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.serializer.dispose();
    this.terminal.dispose();
  }
}
