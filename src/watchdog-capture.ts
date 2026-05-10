// Forensic capture adapters used by the watchdog when it detects a wedged
// parent. The watchdog *loop* (heartbeat staleness, dump orchestration,
// force-kill) is portable; only these leaf operations branch on platform.
//
// macOS: `sample <pid> 5` for stack, `lsof -Pan -p <pid>` for fds.
// Linux: read `/proc/<pid>/{stack,wchan,syscall,status}` for stack,
//        `/proc/<pid>/fd/` (with readlink) for fds — no external commands.
// win32: write a sentinel — capture is not implemented for v1.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

// 10s is enough headroom for `sample <pid> 5` (which runs for 5s by design
// and then writes its output) plus stragglers. `lsof` and the linux /proc
// reads finish well below this in normal cases. The cap exists to bound the
// dump time, not to be tight.
export const CAPTURE_TIMEOUT_MS = 10_000;

const TIMED_OUT_SENTINEL = "\n[uatu watchdog: capture command exceeded 10s cap; output is partial]\n";
const NOT_IMPLEMENTED_SENTINEL = (kind: string, platform: string): string =>
  `[uatu watchdog: ${kind} capture is not implemented on ${platform}]\n`;

export type CaptureResult = {
  contents: string;
  // True when the capture contains a "timed out" marker or sentinel content.
  partial: boolean;
};

export async function captureStack(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<CaptureResult> {
  if (platform === "darwin") {
    return runWithCap("sample", [String(pid), "5"]);
  }
  if (platform === "linux") {
    return readProcStack(pid);
  }
  return {
    contents: NOT_IMPLEMENTED_SENTINEL("stack", platform),
    partial: true,
  };
}

export async function captureFds(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<CaptureResult> {
  if (platform === "darwin") {
    return runWithCap("lsof", ["-Pan", "-p", String(pid)]);
  }
  if (platform === "linux") {
    return readProcFds(pid);
  }
  return {
    contents: NOT_IMPLEMENTED_SENTINEL("fds", platform),
    partial: true,
  };
}

function runWithCap(command: string, args: string[]): Promise<CaptureResult> {
  return new Promise<CaptureResult>(resolve => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

    const finish = (partial: boolean): void => {
      if (settled) return;
      settled = true;
      const tail = partial ? TIMED_OUT_SENTINEL : "";
      const errSection = stderr.length > 0 ? `\n[stderr]\n${stderr}` : "";
      resolve({ contents: `${stdout}${errSection}${tail}`, partial });
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish(true);
    }, CAPTURE_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    child.stdout?.on("data", chunk => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", chunk => {
      stderr += String(chunk);
    });
    child.on("error", err => {
      clearTimeout(timer);
      stderr += `\n[uatu watchdog: spawn failed: ${err.message}]`;
      finish(true);
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

async function readProcStack(pid: number): Promise<CaptureResult> {
  const sources = ["status", "wchan", "syscall", "stack"];
  const sections: string[] = [];
  let partial = false;
  for (const name of sources) {
    const filePath = `/proc/${pid}/${name}`;
    try {
      const text = await fs.readFile(filePath, "utf8");
      sections.push(`=== /proc/${pid}/${name} ===\n${text.trimEnd()}\n`);
    } catch (err) {
      partial = true;
      sections.push(`=== /proc/${pid}/${name} ===\n[unavailable: ${(err as Error).message}]\n`);
    }
  }
  return { contents: sections.join("\n"), partial };
}

async function readProcFds(pid: number): Promise<CaptureResult> {
  const fdDir = `/proc/${pid}/fd`;
  let entries: string[];
  try {
    entries = await fs.readdir(fdDir);
  } catch (err) {
    return {
      contents: `[unavailable: ${fdDir}: ${(err as Error).message}]\n`,
      partial: true,
    };
  }
  const lines: string[] = [`# fds for pid ${pid} (from ${fdDir})`];
  let partial = false;
  await Promise.all(
    entries.map(async name => {
      const fdPath = path.join(fdDir, name);
      try {
        const target = await fs.readlink(fdPath);
        lines.push(`${name}\t${target}`);
      } catch (err) {
        partial = true;
        lines.push(`${name}\t[readlink failed: ${(err as Error).message}]`);
      }
    }),
  );
  // Stable ordering by numeric fd.
  lines.sort((a, b) => {
    const left = Number.parseInt(a.split("\t")[0] ?? "", 10);
    const right = Number.parseInt(b.split("\t")[0] ?? "", 10);
    if (Number.isNaN(left) || Number.isNaN(right)) return 0;
    return left - right;
  });
  return { contents: `${lines.join("\n")}\n`, partial };
}
