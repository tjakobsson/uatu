import { renderMarkdownToHtml } from "../render/markdown";

export function renderChatMarkdown(source: string): string {
  return renderMarkdownToHtml(source).html;
}
