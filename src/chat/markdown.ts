import { renderMarkdownToHtml } from "../render/markdown";
import { measureChatWork } from "./performance";

const cache = new Map<string, string>();
const BYTE_LIMIT = 4 * 1024 * 1024;
let retainedBytes = 0;

export function renderChatMarkdown(source: string): string {
  const cached = cache.get(source);
  if (cached !== undefined) { cache.delete(source); cache.set(source, cached); return cached; }
  const finish = measureChatWork("markdown");
  try {
    const html = renderMarkdownToHtml(source).html;
    const bytes = 2 * (source.length + html.length);
    if (bytes <= BYTE_LIMIT) {
      while (cache.size >= 128 || retainedBytes + bytes > BYTE_LIMIT) {
        const [key, value] = cache.entries().next().value!;
        cache.delete(key);
        retainedBytes -= 2 * (key.length + value.length);
      }
      cache.set(source, html);
      retainedBytes += bytes;
    }
    return html;
  }
  finally { finish(); }
}
