import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { renderDocument } from "./render-dispatch";
import { scanRoots } from "./roots";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("renderDocument", () => {
  test("renders a markdown document through the markdown pipeline", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-render-md-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "README.md");
    await writeFile(filePath, "# Hello\n\nworld\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath);
    expect(rendered.title).toBe("Hello");
    expect(rendered.html).toContain("<p>world</p>");
  });

  test("renders a non-markdown text document as syntax-highlighted code", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-render-code-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "config.yaml");
    await writeFile(filePath, "key: value\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath);
    expect(rendered.title).toBe("config.yaml");
    expect(rendered.html).toContain('<pre class="uatu-source-pre"><code class="hljs language-yaml">');
    expect(rendered.kind).toBe("text");
    expect(rendered.view).toBe("source");
    expect(rendered.language).toBe("yaml");
  });

  test("renders an asciidoc document through the asciidoc pipeline", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-render-adoc-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "README.adoc");
    await writeFile(filePath, "= Hello\n\nworld\n\nNOTE: heads up\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath);
    expect(rendered.kind).toBe("asciidoc");
    expect(rendered.language).toBeNull();
    expect(rendered.title).toBe("Hello");
    expect(rendered.html).toContain("admonitionblock");
    expect(rendered.html).toContain("<p>world</p>");
  });

  test("emits markdown kind and null language for a Markdown document", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-render-md-kind-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "README.md");
    await writeFile(filePath, "# Hello\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath);
    expect(rendered.kind).toBe("markdown");
    expect(rendered.language).toBeNull();
  });

  test("title extraction ignores `#` lines inside fenced code blocks", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-title-fence-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "README.md");
    // No real heading — the only `#` lines live inside a fenced code block.
    // The title should fall back to the filename, NOT pick up "Lockfiles".
    await writeFile(
      filePath,
      "Some intro text.\n\n```gitignore\n# Lockfiles\n*.lock\n```\n",
    );

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath);
    expect(rendered.title).toBe("README");
  });

  test("title extraction picks up an HTML <h1> heading", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-title-html-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "README.md");
    await writeFile(
      filePath,
      `<h1 align="center">uatu</h1>\n\nSome content.\n\n\`\`\`gitignore\n# Lockfiles\n*.lock\n\`\`\`\n`,
    );

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath);
    expect(rendered.title).toBe("uatu");
  });

  test("title extraction prefers a Markdown `# Heading` over later content", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-title-md-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "doc.md");
    await writeFile(filePath, "# Real Title\n\nBody.\n\n```bash\n# comment in code\n```\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath);
    expect(rendered.title).toBe("Real Title");
  });

  test("rejects a binary document with an error", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-render-binary-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "logo.png");
    await writeFile(filePath, "not really png");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    expect(roots[0]?.docs.find(doc => doc.id === filePath)?.kind).toBe("binary");
    await expect(renderDocument(roots, filePath)).rejects.toThrow("document is binary");
  });

  test("rejects an unknown id with not-found", async () => {
    await expect(renderDocument([], "/nope")).rejects.toThrow("document not found");
  });

  test("source view of a markdown document returns verbatim text in a uatu-source-pre block", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-render-md-source-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "README.md");
    const verbatim = "# Hello\n\nworld\n";
    await writeFile(filePath, verbatim);

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath, { view: "source" });
    expect(rendered.title).toBe("README.md");
    expect(rendered.kind).toBe("markdown");
    expect(rendered.view).toBe("source");
    expect(rendered.language).toBe("markdown");
    expect(rendered.html).toContain('<pre class="uatu-source-pre">');
    // Verbatim source must be present (entity-encoded) — markdown markup is
    // displayed, not parsed.
    expect(rendered.html).toContain("# Hello");
    // Rendered HTML for the markdown body MUST NOT appear in source view.
    expect(rendered.html).not.toContain("<p>world</p>");
  });

  test("source view of an asciidoc document returns verbatim text in a uatu-source-pre block", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-render-adoc-source-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "README.adoc");
    await writeFile(filePath, "= Hello\n\nworld\n\nNOTE: heads up\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath, { view: "source" });
    expect(rendered.title).toBe("README.adoc");
    expect(rendered.kind).toBe("asciidoc");
    expect(rendered.view).toBe("source");
    expect(rendered.language).toBe("asciidoc");
    expect(rendered.html).toContain('<pre class="uatu-source-pre">');
    expect(rendered.html).toContain("= Hello");
  });

  test("rendered view of a markdown document returns parsed HTML and the rendered view marker", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-render-md-rendered-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "README.md");
    await writeFile(filePath, "# Hello\n\nworld\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath, { view: "rendered" });
    expect(rendered.kind).toBe("markdown");
    expect(rendered.view).toBe("rendered");
    expect(rendered.html).toContain("<p>world</p>");
    expect(rendered.html).not.toContain("uatu-source-pre");
  });

  test("source view forced for text/source files even when rendered is requested", async () => {
    // Text/source files have no separate rendered representation, so a
    // request for view=rendered still produces source rendering.
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-render-text-rendered-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "config.yaml");
    await writeFile(filePath, "key: value\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath, { view: "rendered" });
    expect(rendered.kind).toBe("text");
    expect(rendered.view).toBe("source");
    expect(rendered.html).toContain('<pre class="uatu-source-pre">');
  });
});
