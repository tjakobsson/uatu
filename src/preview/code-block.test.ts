import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { renderCodeAsHtml, renderMarkdownToHtml } from "../render/markdown";
import { attachCopyButtons, attachLineNumbers, codeBlockCopyText } from "./code-block";

type ParsedWindow = ReturnType<typeof parseHTML>["window"];

function withDom<T>(
  html: string,
  fn: (container: HTMLElement, window: ParsedWindow, nextWrite: () => Promise<string>) => T,
): T {
  const { document, window } = parseHTML(`<div id="root">${html}</div>`);
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const writes: string[] = [];
  const waiters: Array<(value: string) => void> = [];
  const nextWrite = (): Promise<string> => (
    writes.length > 0
      ? Promise.resolve(writes.shift()!)
      : new Promise<string>(resolve => { waiters.push(resolve); })
  );
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(window, { setTimeout: () => 0 }) });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        async writeText(value: string) {
          const waiter = waiters.shift();
          if (waiter) waiter(value);
          else writes.push(value);
        },
      },
    },
  });
  const restore = () => {
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else Reflect.deleteProperty(globalThis, "document");
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
  };
  try {
    const result = fn(document.querySelector("#root") as unknown as HTMLElement, window, nextWrite);
    if (result && typeof (result as unknown as PromiseLike<unknown>).then === "function") {
      return Promise.resolve(result).finally(restore) as T;
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

describe("codeBlockCopyText", () => {
  test("strips the parser-synthesized trailing newline from single-line and multiline Markdown code blocks", () => {
    const single = renderMarkdownToHtml("```sh\ngit status\n```").html;
    const multi = renderMarkdownToHtml("```sh\necho first\n\necho second\n```").html;
    const blankTrailing = renderMarkdownToHtml("```txt\nkeep blank below\n\n```").html;
    withDom(`${single}${multi}${blankTrailing}`, container => {
      const blocks = Array.from(container.querySelectorAll<HTMLPreElement>("pre"));
      expect(blocks).toHaveLength(3);
      expect(codeBlockCopyText(blocks[0]!, blocks[0]!.querySelector("code")!)).toBe("git status");
      expect(codeBlockCopyText(blocks[1]!, blocks[1]!.querySelector("code")!)).toBe("echo first\n\necho second");
      expect(codeBlockCopyText(blocks[2]!, blocks[2]!.querySelector("code")!)).toBe("keep blank below\n");
    });
  });

  test("handles CRLF endings and code blocks without a trailing newline", () => {
    withDom("<pre><code>echo hi\r\n</code></pre><pre><code>echo bare</code></pre><pre><code>\n</code></pre>", container => {
      const blocks = Array.from(container.querySelectorAll<HTMLPreElement>("pre"));
      expect(codeBlockCopyText(blocks[0]!, blocks[0]!.querySelector("code")!)).toBe("echo hi");
      expect(codeBlockCopyText(blocks[1]!, blocks[1]!.querySelector("code")!)).toBe("echo bare");
      expect(codeBlockCopyText(blocks[2]!, blocks[2]!.querySelector("code")!)).toBe("");
    });
  });

  test("preserves verbatim file contents including trailing newline for whole-file source views", () => {
    const html = renderCodeAsHtml("key: value\nport: 4321\n", "yaml");
    withDom(html, container => {
      attachLineNumbers(container);
      const pre = container.querySelector<HTMLPreElement>("pre.uatu-source-pre")!;
      const code = pre.querySelector("code")!;
      expect(codeBlockCopyText(pre, code)).toBe("key: value\nport: 4321\n");
    });
  });

  test("preserves AsciiDoc listing and literal block contents verbatim", () => {
    const html = '<div class="listingblock"><div class="content"><pre><code class="hljs language-sh">npm test\n</code></pre></div></div>'
      + '<div class="literalblock"><div class="content"><pre><code>literal line\n</code></pre></div></div>';
    withDom(html, container => {
      const blocks = Array.from(container.querySelectorAll<HTMLPreElement>("pre"));
      expect(blocks).toHaveLength(2);
      expect(codeBlockCopyText(blocks[0]!, blocks[0]!.querySelector("code")!)).toBe("npm test\n");
      expect(codeBlockCopyText(blocks[1]!, blocks[1]!.querySelector("code")!)).toBe("literal line\n");
    });
  });
});

describe("attachCopyButtons", () => {
  test("copies rendered Markdown fenced code blocks without a trailing newline", async () => {
    const html = renderMarkdownToHtml("```bash\nbun test\n```\n\n```ts\nconst a = 1;\nconst b = 2;\n```").html;
    await withDom(html, async (container, window, nextWrite) => {
      attachCopyButtons(container);
      const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("pre > .code-copy"));
      expect(buttons).toHaveLength(2);
      const firstWrite = nextWrite();
      buttons[0]!.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
      const secondWrite = nextWrite();
      buttons[1]!.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
      expect(await Promise.all([firstWrite, secondWrite])).toEqual(["bun test", "const a = 1;\nconst b = 2;"]);
    });
  });
});
