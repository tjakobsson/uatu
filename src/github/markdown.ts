// GitHub Markdown bodies (design D13): rendered in the session child from
// `body`, never GitHub's `bodyHTML`, through the document preview's own
// sanitizing renderer. Relative links and images resolve against the pull
// request's GitHub URL, as they do on github.com; absolute ones keep the
// schema's protocol allowlist (no `javascript:`), and external links open in
// a new tab. Plain strings (titles, logins, branch names) are escaped where
// the client renders them.

import { renderMarkdownToHtml } from "../render/markdown";

export function renderGithubMarkdown(body: string, pullRequestUrl: string): string {
  return body.trim() === "" ? "" : renderMarkdownToHtml(body, { baseUrl: pullRequestUrl }).html;
}
