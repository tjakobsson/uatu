// Best-effort foreground-process labels for PTY shells. uatu's PTY layer is
// Bun's native terminal spawn (see pty.ts), which has no node-pty-style
// `process` getter — so the session inventory resolves labels by asking the
// OS which child of each shell is in the foreground.
//
// This is the module's whole job so the OS-specific bit stays isolated:
// callers get a Map and a `null`-shaped absence, never a platform branch.
// POSIX only (one `ps` snapshot per call); on Windows — where the terminal
// backend reports unavailable anyway — or on any failure/timeout, labels are
// simply absent and the caller falls back to the shell name. Labels are
// advisory UI, never authority: a wrong guess mislabels a picker row, so
// every doubtful case resolves to null.

const PS_TIMEOUT_MS = 250;

type PsRow = {
  pid: number;
  ppid: number;
  // `stat` includes "+" for members of the terminal's foreground process
  // group on both BSD (macOS) and Linux ps.
  foreground: boolean;
  command: string;
};

// One `ps` snapshot parsed into rows. Exported for tests.
export function parsePsSnapshot(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // pid, ppid, stat, comm — comm may contain spaces (e.g. paths), so only
    // the first three columns are split off.
    const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(trimmed);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      foreground: match[3]!.includes("+"),
      command: match[4]!.trim(),
    });
  }
  return rows;
}

// Choose the label for one shell: the newest (highest-pid) foreground child.
// No foreground child (shell sitting at its prompt) → null. Exported for
// tests; pure over the snapshot.
export function pickForegroundChild(rows: PsRow[], shellPid: number): string | null {
  let best: PsRow | null = null;
  for (const row of rows) {
    if (row.ppid !== shellPid || !row.foreground || row.pid === shellPid) continue;
    if (!best || row.pid > best.pid) best = row;
  }
  if (!best) return null;
  // `comm` can be a full path; the basename is the human label.
  const base = best.command.split("/").at(-1) ?? best.command;
  return base.length > 0 ? base : null;
}

// Resolve labels for many shells from a single `ps` snapshot. Missing map
// entries mean "no label" — callers fall back to the shell name.
export async function resolveForegroundLabels(
  shellPids: number[],
): Promise<Map<number, string>> {
  const labels = new Map<number, string>();
  if (shellPids.length === 0 || process.platform === "win32") return labels;

  let output: string;
  try {
    const proc = Bun.spawn(["ps", "-ax", "-o", "pid=,ppid=,stat=,comm="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const killTimer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // Already exited.
      }
    }, PS_TIMEOUT_MS);
    output = await new Response(proc.stdout).text();
    clearTimeout(killTimer);
  } catch {
    return labels;
  }

  const rows = parsePsSnapshot(output);
  for (const pid of shellPids) {
    const label = pickForegroundChild(rows, pid);
    if (label) labels.set(pid, label);
  }
  return labels;
}
