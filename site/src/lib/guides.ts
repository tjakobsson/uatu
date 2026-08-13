import authentication from "../../../api/guides/authentication.md?raw";
import boundaries from "../../../api/guides/boundaries.md?raw";
import cloneJobs from "../../../api/guides/clone-jobs.md?raw";
import compatibility from "../../../api/guides/compatibility.md?raw";
import errors from "../../../api/guides/errors.md?raw";
import streaming from "../../../api/guides/streaming.md?raw";
import workspaces from "../../../api/guides/workspaces.md?raw";

export const guides = [
  { slug: "authentication", title: "Authentication", summary: "Sessions, bearer credentials, cookies, CSRF, and terminal authorization.", source: authentication },
  { slug: "boundaries", title: "Hub and workspace boundaries", summary: "Know which service owns identity, lifecycle, documents, and terminals.", source: boundaries },
  { slug: "workspaces", title: "Workspace lifecycle", summary: "Register, start, observe, stop, and forget workspaces safely.", source: workspaces },
  { slug: "clone-jobs", title: "Clone jobs", summary: "Drive asynchronous clones, prompts, progress, and cancellation.", source: cloneJobs },
  { slug: "streaming", title: "Streaming protocols", summary: "Consume SSE, NDJSON, and mixed-frame terminal WebSockets.", source: streaming },
  { slug: "errors", title: "Errors", summary: "Handle HTTP and stream failures without relying on display text.", source: errors },
  { slug: "compatibility", title: "Compatibility", summary: "Compare Hub and workspace revisions and apply migrations.", source: compatibility },
] as const;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function inlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
      const resolved = href.startsWith("../") ? `/uatu/api/edge/${href.slice(3)}` : href;
      return `<a href="${resolved}">${label}</a>`;
    });
}

export function renderGuide(source: string): string {
  const blocks: string[] = [];
  let list: string[] = [];
  let paragraph: string[] = [];
  const flushList = () => {
    if (list.length) blocks.push(`<ul>${list.map(item => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  const flushParagraph = () => {
    if (paragraph.length) blocks.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  for (const line of source.split("\n")) {
    if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (line.startsWith("# ")) {
      flushParagraph();
      flushList();
    } else if (line.startsWith("## ")) {
      flushParagraph();
      flushList();
      blocks.push(`<h2>${inlineMarkdown(line.slice(3))}</h2>`);
    } else if (/^(?:- |\d+\. )/.test(line)) {
      flushParagraph();
      list.push(line.replace(/^(?:- |\d+\. )/, ""));
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks.join("\n");
}
