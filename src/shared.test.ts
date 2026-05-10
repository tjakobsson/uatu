import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MODE,
  MODE_STORAGE_KEY,
  defaultDocumentId,
  isMode,
  nextSelectedDocumentId,
  readModePreference,
  reviewBurdenHeadlineLabel,
  shouldRefreshPreview,
  writeModePreference,
  type Mode,
  type RootGroup,
} from "./shared";

const roots: RootGroup[] = [
  {
    id: "/tmp/docs",
    label: "docs",
    path: "/tmp/docs",
    docs: [
      {
        id: "/tmp/docs/README.md",
        name: "README.md",
        relativePath: "README.md",
        mtimeMs: 2,
        rootId: "/tmp/docs",
        kind: "markdown",
      },
      {
        id: "/tmp/docs/guides/setup.md",
        name: "setup.md",
        relativePath: "guides/setup.md",
        mtimeMs: 5,
        rootId: "/tmp/docs",
        kind: "markdown",
      },
    ],
    hiddenCount: 0,
  },
];

describe("shouldRefreshPreview", () => {
  test("refreshes when the selected document changes on disk", () => {
    expect(shouldRefreshPreview("/tmp/docs/README.md", "/tmp/docs/README.md")).toBe(true);
    expect(shouldRefreshPreview("/tmp/docs/README.md", "/tmp/docs/guides/setup.md")).toBe(false);
  });
});

describe("defaultDocumentId", () => {
  test("returns the most recently modified non-binary document", () => {
    const mixed: RootGroup[] = [
      {
        id: "/tmp/repo",
        label: "repo",
        path: "/tmp/repo",
        docs: [
          {
            id: "/tmp/repo/README.md",
            name: "README.md",
            relativePath: "README.md",
            mtimeMs: 5,
            rootId: "/tmp/repo",
            kind: "markdown",
          },
          {
            id: "/tmp/repo/logo.png",
            name: "logo.png",
            relativePath: "logo.png",
            mtimeMs: 10,
            rootId: "/tmp/repo",
            kind: "binary",
          },
        ],
        hiddenCount: 0,
      },
    ];

    expect(defaultDocumentId(mixed)).toBe("/tmp/repo/README.md");
  });

  test("returns null when only binary documents are indexed", () => {
    const onlyBinary: RootGroup[] = [
      {
        id: "/tmp/assets",
        label: "assets",
        path: "/tmp/assets",
        docs: [
          {
            id: "/tmp/assets/logo.png",
            name: "logo.png",
            relativePath: "logo.png",
            mtimeMs: 1,
            rootId: "/tmp/assets",
            kind: "binary",
          },
        ],
        hiddenCount: 0,
      },
    ];

    expect(defaultDocumentId(onlyBinary)).toBeNull();
  });
});

describe("nextSelectedDocumentId", () => {
  test("follows the latest changed markdown document when follow is enabled", () => {
    expect(nextSelectedDocumentId(roots, "/tmp/docs/README.md", "/tmp/docs/guides/setup.md", true)).toBe(
      "/tmp/docs/guides/setup.md",
    );
  });

  test("follows the latest changed non-markdown text document when follow is enabled", () => {
    const mixed: RootGroup[] = [
      {
        id: "/tmp/repo",
        label: "repo",
        path: "/tmp/repo",
        docs: [
          {
            id: "/tmp/repo/README.md",
            name: "README.md",
            relativePath: "README.md",
            mtimeMs: 1,
            rootId: "/tmp/repo",
            kind: "markdown",
          },
          {
            id: "/tmp/repo/script.py",
            name: "script.py",
            relativePath: "script.py",
            mtimeMs: 2,
            rootId: "/tmp/repo",
            kind: "text",
          },
        ],
        hiddenCount: 0,
      },
    ];

    expect(nextSelectedDocumentId(mixed, "/tmp/repo/README.md", "/tmp/repo/script.py", true)).toBe(
      "/tmp/repo/script.py",
    );
  });

  test("ignores a binary changedId under follow mode", () => {
    const mixed: RootGroup[] = [
      {
        id: "/tmp/repo",
        label: "repo",
        path: "/tmp/repo",
        docs: [
          {
            id: "/tmp/repo/README.md",
            name: "README.md",
            relativePath: "README.md",
            mtimeMs: 1,
            rootId: "/tmp/repo",
            kind: "markdown",
          },
          {
            id: "/tmp/repo/logo.png",
            name: "logo.png",
            relativePath: "logo.png",
            mtimeMs: 99,
            rootId: "/tmp/repo",
            kind: "binary",
          },
        ],
        hiddenCount: 0,
      },
    ];

    expect(nextSelectedDocumentId(mixed, "/tmp/repo/README.md", "/tmp/repo/logo.png", true)).toBe(
      "/tmp/repo/README.md",
    );
  });

  test("keeps the current selection pinned when follow is disabled", () => {
    expect(nextSelectedDocumentId(roots, "/tmp/docs/README.md", "/tmp/docs/guides/setup.md", false)).toBe(
      "/tmp/docs/README.md",
    );
  });
});

describe("isMode", () => {
  test("accepts the two valid Mode strings", () => {
    expect(isMode("author")).toBe(true);
    expect(isMode("review")).toBe(true);
  });

  test("rejects everything else", () => {
    expect(isMode(null)).toBe(false);
    expect(isMode(undefined)).toBe(false);
    expect(isMode("")).toBe(false);
    expect(isMode("AUTHOR")).toBe(false);
    expect(isMode("write")).toBe(false);
    expect(isMode(42)).toBe(false);
  });
});

describe("reviewBurdenHeadlineLabel", () => {
  test("returns the forecast label in author mode", () => {
    expect(reviewBurdenHeadlineLabel("author")).toBe("Reviewer burden forecast");
  });

  test("returns the change-review label in review mode", () => {
    expect(reviewBurdenHeadlineLabel("review")).toBe("Change review burden");
  });
});

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe("readModePreference", () => {
  test("returns the default when storage is null and no startup mode is given", () => {
    expect(readModePreference(null)).toBe(DEFAULT_MODE);
    expect(readModePreference(undefined)).toBe(DEFAULT_MODE);
  });

  test("returns the default when storage has no value", () => {
    const storage = new MemoryStorage();
    expect(readModePreference(storage)).toBe(DEFAULT_MODE);
  });

  test("returns the persisted value when valid", () => {
    const storage = new MemoryStorage();
    storage.setItem(MODE_STORAGE_KEY, "review");
    expect(readModePreference(storage)).toBe("review");
  });

  test("returns the default when the persisted value is invalid", () => {
    const storage = new MemoryStorage();
    storage.setItem(MODE_STORAGE_KEY, "writer");
    expect(readModePreference(storage)).toBe(DEFAULT_MODE);
  });

  test("startupMode overrides any persisted value", () => {
    const storage = new MemoryStorage();
    storage.setItem(MODE_STORAGE_KEY, "review");
    expect(readModePreference(storage, "author")).toBe("author");
  });

  test("startupMode is ignored when not a valid Mode value", () => {
    const storage = new MemoryStorage();
    storage.setItem(MODE_STORAGE_KEY, "review");
    expect(readModePreference(storage, "garbage" as unknown as Mode)).toBe("review");
  });

  test("boot precedence is startupMode > persisted > default", () => {
    const noStorage = null;
    const empty = new MemoryStorage();
    const persisted = new MemoryStorage();
    persisted.setItem(MODE_STORAGE_KEY, "review");

    // No storage, no startup → default.
    expect(readModePreference(noStorage)).toBe(DEFAULT_MODE);
    // Empty storage, no startup → default.
    expect(readModePreference(empty)).toBe(DEFAULT_MODE);
    // Persisted only → persisted wins.
    expect(readModePreference(persisted)).toBe("review");
    // Persisted + startupMode → startupMode wins.
    expect(readModePreference(persisted, "author")).toBe("author");
    // No storage but startupMode set → startupMode wins.
    expect(readModePreference(noStorage, "review")).toBe("review");
  });

  test("falls back to default when storage throws on read", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
    };
    expect(readModePreference(throwing)).toBe(DEFAULT_MODE);
  });
});

describe("writeModePreference", () => {
  test("persists the given mode through the storage", () => {
    const storage = new MemoryStorage();
    writeModePreference(storage, "review");
    expect(storage.getItem(MODE_STORAGE_KEY)).toBe("review");
  });

  test("is a no-op when storage is null", () => {
    expect(() => writeModePreference(null, "review")).not.toThrow();
    expect(() => writeModePreference(undefined, "author")).not.toThrow();
  });

  test("swallows storage errors silently", () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(() => writeModePreference(throwing, "review")).not.toThrow();
  });
});
