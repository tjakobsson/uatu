// Incremental Server-Sent Events parser for the bodies the hub reads from a
// workspace child. The child's routes are the internal hub↔child protocol;
// this turns their byte stream into frames the broker can stamp and fan
// out. Comment frames (keepalives) are reported separately from events so
// the broker can treat them as liveness without forwarding them.

export type SseFrame = {
  id?: string;
  event: string;
  data: string;
};

export class SseFrameParser {
  private pending = "";
  private readonly decoder = new TextDecoder();

  // Feeds one chunk and returns every complete frame it closed. A frame
  // made only of comments yields `{ comment: true }` so a keepalive is still
  // observable (the upstream is alive) without becoming an event.
  push(chunk: Uint8Array): Array<SseFrame | { comment: true }> {
    this.pending += this.decoder.decode(chunk, { stream: true });
    const frames: Array<SseFrame | { comment: true }> = [];
    for (;;) {
      const boundary = findFrameBoundary(this.pending);
      if (!boundary) break;
      const block = this.pending.slice(0, boundary.index);
      this.pending = this.pending.slice(boundary.index + boundary.length);
      const parsed = parseBlock(block);
      if (parsed) frames.push(parsed);
    }
    return frames;
  }
}

function findFrameBoundary(text: string): { index: number; length: number } | null {
  const lf = text.indexOf("\n\n");
  const crlf = text.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseBlock(block: string): SseFrame | { comment: true } | null {
  let id: string | undefined;
  let event = "message";
  const data: string[] = [];
  let sawComment = false;
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine === "") continue;
    if (rawLine.startsWith(":")) {
      sawComment = true;
      continue;
    }
    const separator = rawLine.indexOf(":");
    const field = separator < 0 ? rawLine : rawLine.slice(0, separator);
    const value = separator < 0 ? "" : rawLine.slice(separator + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return sawComment ? { comment: true } : null;
  return { ...(id === undefined ? {} : { id }), event, data: data.join("\n") };
}
