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

// The one line every consumer of piped stdout parses (the desktop wrapper,
// the hub's local backend): the session URL, carrying the base path so a
// supervisor can load the session without reconstructing the prefix. At the
// default "/" the output stays exactly what it always was — including the
// slashless origin-only form when the terminal is unavailable.
export function formatSessionUrl(port: number, basePath: string, token?: string): string {
  const origin = `http://127.0.0.1:${port}`;
  if (typeof token === "string") {
    return `${origin}${basePath}?t=${encodeURIComponent(token)}`;
  }
  return basePath === "/" ? origin : `${origin}${basePath}`;
}

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
