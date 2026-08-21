import path from "node:path";

import { stripAmbientCredentialEnvironment, type CloneCredentialProcessContext } from "./credential-context";

const TERM_GRACE_MS = 3_000;
const TERMINAL_ECHO_FLAG = 0x00000008;

export type CloneProcess = {
  readonly pid: number;
  readonly exited: Promise<number>;
  writeLine(value: string): boolean;
  terminate(): Promise<void>;
};

export type CloneProcessStart = {
  url: string;
  target: string;
  credential?: CloneCredentialProcessContext;
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
  gitCommand?: string | (() => string);
  spawn?: (argv: string[], options: Parameters<typeof Bun.spawn>[1]) => SpawnedClone;
  killGroup?: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  termGraceMs?: number;
};

export function buildCloneEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = stripAmbientCredentialEnvironment(source);
  env.GIT_TERMINAL_PROMPT = "1";
  env.SSH_ASKPASS_REQUIRE = "never";
  return env;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildCloneArguments(url: string, target: string, credential?: CloneCredentialProcessContext): string[] {
  const args = [
    "-c", "core.askPass=",
    "-c", "credential.helper=",
  ];
  if (credential?.type === "https") {
    const helper = [
      "!env",
      `UATU_HUB_STATE_ROOT=${shellQuote(credential.stateRoot)}`,
      `UATU_CREDENTIAL_ID=${shellQuote(credential.credentialId)}`,
      ...credential.uatuArgv.map(shellQuote),
      "--git-credential-helper",
    ].join(" ");
    args.push("-c", `credential.https://${credential.host}.helper=${helper}`);
  }
  args.push("clone", "--", url, target);
  return args;
}

export class CloneProcessAdapter implements CloneProcessFactory {
  private readonly env: Record<string, string>;
  private readonly gitCommand: string | (() => string);
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
    const env = { ...this.env };
    if (options.credential?.type === "ssh") {
      env.SSH_AUTH_SOCK = options.credential.agentSocket;
      // OpenSSH expands %-tokens inside IdentityAgent/IdentityFile values
      // even through shell quoting, so a state directory containing `%h`
      // would resolve to a different path; `%%` is the literal form.
      const sshOptionValue = (value: string) => shellQuote(value.replaceAll("%", "%%"));
      env.GIT_SSH_COMMAND = [
        shellQuote(options.credential.sshPath),
        `-o IdentityAgent=${sshOptionValue(options.credential.agentSocket)}`,
        `-o IdentityFile=${sshOptionValue(options.credential.publicKeyPath)}`,
        "-o IdentitiesOnly=yes",
      ].join(" ");
    }
    const gitCommand = typeof this.gitCommand === "function" ? this.gitCommand() : this.gitCommand;
    const proc = this.spawn([gitCommand, ...buildCloneArguments(options.url, options.target, options.credential)], {
      cwd: path.dirname(options.target),
      env,
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
        if (!terminal) return false;
        try {
          // A PTY starts with terminal echo enabled. Git and SSH normally
          // disable it for secrets, but arbitrary/unrecognized prompts may
          // not; clear ECHO immediately before every response so submitted
          // credentials can never return through captured output/replay.
          terminal.localFlags &= ~TERMINAL_ECHO_FLAG;
          terminal.write(`${value}\n`);
          return true;
        } catch {
          // Process may have exited between the active-state check and write.
          return false;
        }
      },
      terminate: () => {
        terminating ??= this.terminateGroup(proc.pid, exited).catch(error => {
          terminating = undefined;
          throw error;
        });
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
    const killDeadline = Date.now() + this.termGraceMs;
    while (Date.now() < killDeadline && this.groupExists(pid)) {
      await this.sleep(Math.min(25, Math.max(1, killDeadline - Date.now())));
    }
    if (this.groupExists(pid)) {
      throw new Error(`clone process group ${pid} did not exit after SIGKILL`);
    }
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
