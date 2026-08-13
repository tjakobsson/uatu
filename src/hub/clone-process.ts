import path from "node:path";

const TERM_GRACE_MS = 3_000;
const TERMINAL_ECHO_FLAG = 0x00000008;

export type CloneProcess = {
  readonly pid: number;
  readonly exited: Promise<number>;
  writeLine(value: string): void;
  terminate(): Promise<void>;
};

export type CloneProcessStart = {
  url: string;
  target: string;
  onOutput(output: string): void;
};

export interface CloneProcessFactory {
  start(options: CloneProcessStart): CloneProcess;
}

type BunTerminal = {
  localFlags: number;
  write(data: string): void;
  close(): void;
};

type SpawnedClone = {
  pid: number;
  exited: Promise<number | null>;
  terminal?: BunTerminal;
};

export type CloneProcessAdapterOptions = {
  env?: NodeJS.ProcessEnv;
  gitCommand?: string;
  spawn?: (argv: string[], options: Parameters<typeof Bun.spawn>[1]) => SpawnedClone;
  killGroup?: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  termGraceMs?: number;
};

export function buildCloneEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && name !== "GIT_ASKPASS" && name !== "SSH_ASKPASS") {
      env[name] = value;
    }
  }
  env.GIT_TERMINAL_PROMPT = "1";
  env.SSH_ASKPASS_REQUIRE = "never";
  return env;
}

export function buildCloneArguments(url: string, target: string): string[] {
  return [
    "-c", "core.askPass=",
    "-c", "credential.helper=",
    "clone", "--", url, target,
  ];
}

export class CloneProcessAdapter implements CloneProcessFactory {
  private readonly env: Record<string, string>;
  private readonly gitCommand: string;
  private readonly spawn: NonNullable<CloneProcessAdapterOptions["spawn"]>;
  private readonly killGroup: NonNullable<CloneProcessAdapterOptions["killGroup"]>;
  private readonly sleep: NonNullable<CloneProcessAdapterOptions["sleep"]>;
  private readonly termGraceMs: number;

  constructor(options: CloneProcessAdapterOptions = {}) {
    this.env = buildCloneEnvironment(options.env);
    this.gitCommand = options.gitCommand ?? "git";
    this.spawn = options.spawn ?? ((argv, spawnOptions) => Bun.spawn(argv, spawnOptions) as SpawnedClone);
    this.killGroup = options.killGroup ?? ((pid, signal) => process.kill(-pid, signal));
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.termGraceMs = options.termGraceMs ?? TERM_GRACE_MS;
  }

  start(options: CloneProcessStart): CloneProcess {
    const normalizer = new TerminalTextNormalizer(options.onOutput);
    let terminal: BunTerminal | undefined;
    const proc = this.spawn([this.gitCommand, ...buildCloneArguments(options.url, options.target)], {
      cwd: path.dirname(options.target),
      env: this.env,
      detached: true,
      terminal: {
        cols: 100,
        rows: 24,
        data(activeTerminal, bytes) {
          terminal = activeTerminal as BunTerminal;
          normalizer.write(bytes);
        },
      },
    } as Parameters<typeof Bun.spawn>[1]);
    terminal = proc.terminal ?? terminal;

    const exited = proc.exited.then(code => code ?? 128).finally(() => {
      normalizer.end();
      try {
        terminal?.close();
      } catch {
        // The PTY may already have closed with the process.
      }
    });
    let terminating: Promise<void> | undefined;

    return {
      pid: proc.pid,
      exited,
      writeLine(value) {
        if (!terminal) return;
        try {
          // A PTY starts with terminal echo enabled. Git and SSH normally
          // disable it for secrets, but arbitrary/unrecognized prompts may
          // not; clear ECHO immediately before every response so submitted
          // credentials can never return through captured output/replay.
          terminal.localFlags &= ~TERMINAL_ECHO_FLAG;
          terminal.write(`${value}\n`);
        } catch {
          // Process may have exited between the active-state check and write.
        }
      },
      terminate: () => {
        terminating ??= this.terminateGroup(proc.pid, exited);
        return terminating;
      },
    };
  }

  private async terminateGroup(pid: number, exited: Promise<number>): Promise<void> {
    try {
      this.killGroup(pid, "SIGTERM");
    } catch {
      await exited.catch(() => undefined);
      return;
    }

    const deadline = Date.now() + this.termGraceMs;
    while (Date.now() < deadline && this.groupExists(pid)) {
      await this.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
    }
    if (this.groupExists(pid)) {
      try {
        this.killGroup(pid, "SIGKILL");
      } catch {
        // The process group exited between the probe and signal.
      }
    }
    await exited.catch(() => undefined);
  }

  private groupExists(pid: number): boolean {
    try {
      this.killGroup(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

class TerminalTextNormalizer {
  private readonly decoder = new TextDecoder();
  private state: "text" | "escape" | "csi" | "osc" | "osc-escape" = "text";
  private previousCarriageReturn = false;

  constructor(private readonly emit: (output: string) => void) {}

  write(bytes: Uint8Array): void {
    this.consume(this.decoder.decode(bytes, { stream: true }));
  }

  end(): void {
    this.consume(this.decoder.decode());
  }

  private consume(input: string): void {
    let output = "";
    for (const character of input) {
      if (this.state === "escape") {
        this.state = character === "[" ? "csi" : character === "]" ? "osc" : "text";
        continue;
      }
      if (this.state === "csi") {
        if (character >= "@" && character <= "~") this.state = "text";
        continue;
      }
      if (this.state === "osc") {
        if (character === "\u0007") this.state = "text";
        else if (character === "\u001b") this.state = "osc-escape";
        continue;
      }
      if (this.state === "osc-escape") {
        this.state = character === "\\" ? "text" : "osc";
        continue;
      }
      if (character === "\u001b") {
        this.state = "escape";
        continue;
      }
      if (character === "\r") {
        output += "\n";
        this.previousCarriageReturn = true;
        continue;
      }
      if (character === "\n" && this.previousCarriageReturn) {
        this.previousCarriageReturn = false;
        continue;
      }
      this.previousCarriageReturn = false;
      const codePoint = character.codePointAt(0) ?? 0;
      if (character === "\n" || character === "\t" || (codePoint >= 0x20 && codePoint !== 0x7f && !(codePoint >= 0x80 && codePoint <= 0x9f))) {
        output += character;
      }
    }
    if (output !== "") this.emit(output);
  }
}
