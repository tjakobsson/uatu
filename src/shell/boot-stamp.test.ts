// The pre-paint stamp in index.html is a classic inline <script> — the only
// thing that runs before <body> is parsed, and therefore the only place the
// data-ui-mode / data-active-tab attributes can be set without letting a touch
// device flash a frame of desktop layout. Being inline HTML, it cannot import
// resolveUiMode / readActiveTabPreference, so it restates them.
//
// This suite is what keeps the restatement honest: it extracts the actual
// script out of index.html, executes it against stubbed globals, and asserts
// it agrees with the TypeScript resolvers over the full input matrix. The
// storage prefix is pinned by writing through presentationStorage() rather
// than hardcoding it here, so a change to the prefix scheme fails loudly
// instead of silently reading null forever.

import { describe, expect, test } from "bun:test";

import { presentationStorage } from "./presentation-storage";
import { resolveUiMode, UI_MODE_KEY } from "./ui-mode";
import { ACTIVE_TAB_KEY, readActiveTabPreference, type TouchTab } from "./state";

const html = await Bun.file(`${import.meta.dir}/../index.html`).text();

// Pulled out with a real HTML parser rather than a regex. Matching tags by
// pattern is exactly what CodeQL's js/bad-tag-filter warns about — the
// obvious /<script>([\s\S]*?)<\/script>/ silently misses <SCRIPT> and any
// attribute that appears later — and it would still have to know which of
// the shell's scripts is which. HTMLRewriter settles both: the boot stamp is
// the one script with no src, where app.ts's is <script type="module" src>.
const bootStampSource = await (async () => {
  const chunks: string[] = [];
  let capturing = false;
  const parsed = new HTMLRewriter()
    .on("script", {
      element: element => {
        capturing = element.getAttribute("src") === null;
      },
      text: chunk => {
        if (capturing) chunks.push(chunk.text);
      },
    })
    .transform(new Response(html));
  await parsed.text();
  if (chunks.length === 0) throw new Error("index.html has no inline boot-stamp script");
  return chunks.join("");
})();

/** Backing map for a Storage the presentation wrapper can write through. */
function rawStorage(store: Map<string, string>): Storage {
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: key => store.get(key) ?? null,
    key: index => [...store.keys()][index] ?? null,
    removeItem: key => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  } as Storage;
}

type StampOptions = {
  basePath?: string | null;
  store?: Map<string, string>;
  coarse?: boolean;
  noMatchMedia?: boolean;
  throwOnRead?: boolean;
};

/** Runs the real inline script and returns the attributes it stamped. */
function runBootStamp(options: StampOptions = {}): Record<string, string> {
  const { basePath = null, store = new Map<string, string>(), coarse = false } = options;
  const attributes: Record<string, string> = {};
  const documentStub = {
    documentElement: {
      setAttribute: (name: string, value: string) => {
        attributes[name] = value;
      },
    },
    querySelector: (selector: string) =>
      selector === 'meta[name="uatu-base-path"]' && basePath !== null
        ? { getAttribute: () => basePath }
        : null,
  };
  const windowStub = {
    localStorage: {
      getItem: (key: string) => {
        if (options.throwOnRead) throw new Error("denied");
        return store.get(key) ?? null;
      },
    },
    matchMedia: options.noMatchMedia ? undefined : () => ({ matches: coarse }),
  };
  new Function("document", "window", bootStampSource)(documentStub, windowStub);
  return attributes;
}

/** Seeds a value under the same prefix the app writes through. */
function seed(store: Map<string, string>, key: string, value: string, basePath = "/"): void {
  presentationStorage(rawStorage(store), basePath).setItem(key, value);
}

describe("boot stamp — data-ui-mode", () => {
  test("fine pointer with no override matches resolveUiMode", () => {
    expect(runBootStamp({ coarse: false })["data-ui-mode"]).toBe(resolveUiMode(null, false));
  });

  test("coarse pointer with no override matches resolveUiMode", () => {
    expect(runBootStamp({ coarse: true })["data-ui-mode"]).toBe(resolveUiMode(null, true));
  });

  test("a stored override wins over the pointer default, both directions", () => {
    for (const [stored, coarse] of [
      ["desktop", true],
      ["touch", false],
    ] as const) {
      const store = new Map<string, string>();
      seed(store, UI_MODE_KEY, stored);
      expect(runBootStamp({ store, coarse })["data-ui-mode"]).toBe(
        resolveUiMode(stored, coarse),
      );
    }
  });

  test("an unrecognized stored value falls back to the pointer default", () => {
    const store = new Map<string, string>();
    seed(store, UI_MODE_KEY, "phablet");
    expect(runBootStamp({ store, coarse: true })["data-ui-mode"]).toBe(
      resolveUiMode("phablet", true),
    );
  });

  test("a missing matchMedia degrades to desktop rather than throwing", () => {
    expect(() => runBootStamp({ noMatchMedia: true })).not.toThrow();
    expect(runBootStamp({ noMatchMedia: true })["data-ui-mode"]).toBe("desktop");
  });

  test("a throwing localStorage degrades to the pointer default", () => {
    expect(runBootStamp({ throwOnRead: true, coarse: true })["data-ui-mode"]).toBe("touch");
  });
});

describe("boot stamp — data-active-tab", () => {
  test("no stored preference matches readActiveTabPreference's default", () => {
    expect(runBootStamp()["data-active-tab"]).toBe(readActiveTabPreference(null));
  });

  test("each valid stored tab round-trips", () => {
    for (const tab of ["files", "preview", "terminal"] as TouchTab[]) {
      const store = new Map<string, string>();
      seed(store, ACTIVE_TAB_KEY, tab);
      expect(runBootStamp({ store })["data-active-tab"]).toBe(
        readActiveTabPreference(presentationStorage(rawStorage(store), "/")),
      );
    }
  });

  test("an unrecognized stored tab falls back to preview", () => {
    const store = new Map<string, string>();
    seed(store, ACTIVE_TAB_KEY, "settings");
    expect(runBootStamp({ store })["data-active-tab"]).toBe("preview");
  });
});

describe("boot stamp — base-path scoping", () => {
  test("reads the prefix the app writes under a base path", () => {
    const store = new Map<string, string>();
    seed(store, UI_MODE_KEY, "touch", "/s/abc/");
    expect(runBootStamp({ store, basePath: "/s/abc/", coarse: false })["data-ui-mode"]).toBe(
      "touch",
    );
  });

  test("does not leak another session's preference across base paths", () => {
    const store = new Map<string, string>();
    seed(store, UI_MODE_KEY, "touch", "/s/abc/");
    // No meta tag => base path "/", a different storage scope entirely.
    expect(runBootStamp({ store, basePath: null, coarse: false })["data-ui-mode"]).toBe("desktop");
  });
});
