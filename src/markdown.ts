import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

export function renderMarkdownToHtml(source: string): string {
  return micromark(source, {
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  });
}
