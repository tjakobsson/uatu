// TTY startup output: the ASCII banner and the transient indexing status.
// Both are TTY-gated so piped stdout receives only the URL line.

import type { WatchEntry } from "../server/roots";

export const STARTUP_BANNER = `\
██╗   ██╗ █████╗ ████████╗██╗   ██╗
██║   ██║██╔══██╗╚══██╔══╝██║   ██║
██║   ██║███████║   ██║   ██║   ██║
██║   ██║██╔══██║   ██║   ██║   ██║
╚██████╔╝██║  ██║   ██║   ╚██████╔╝
 ╚═════╝ ╚═╝  ╚═╝   ╚═╝    ╚═════╝

I observe. I follow. I render.`;

export function printStartupBanner(
  stream: { isTTY?: boolean; write(chunk: string): unknown } = process.stdout,
): void {
  if (!stream.isTTY) {
    return;
  }

  stream.write(`\n${STARTUP_BANNER}\n\n`);
}

export function printIndexingStatus(
  entries: WatchEntry[],
  stream: { isTTY?: boolean; write(chunk: string): unknown } = process.stdout,
): () => void {
  if (!stream.isTTY) {
    return () => undefined;
  }

  const label = entries.length === 1 ? entries[0]!.absolutePath : `${entries.length} roots`;
  const message = `Indexing ${label}...`;
  let cleared = false;
  stream.write(message);

  return () => {
    if (cleared) {
      return;
    }
    cleared = true;
    stream.write(`\r${" ".repeat(message.length)}\r`);
  };
}
