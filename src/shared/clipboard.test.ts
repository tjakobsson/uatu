import { afterEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";

import { writeClipboardText } from "./clipboard";

const globals = globalThis as unknown as {
  document?: Document;
  navigator?: Navigator;
};
const originalDocument = globals.document;
const originalNavigator = globals.navigator;

function installDocument(execCommand?: (command: string) => boolean): Document {
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  const testDocument = document as unknown as Document;
  const textareaPrototype = Object.getPrototypeOf(testDocument.createElement("textarea")) as {
    select?: () => void;
  };
  textareaPrototype.select ??= () => undefined;
  if (execCommand) {
    Object.defineProperty(testDocument, "execCommand", {
      configurable: true,
      value: execCommand,
    });
  }
  globals.document = testDocument;
  return testDocument;
}

function installClipboard(writeText: (text: string) => Promise<void>): void {
  globals.navigator = { clipboard: { writeText } } as unknown as Navigator;
}

afterEach(() => {
  globals.document = originalDocument;
  globals.navigator = originalNavigator;
});

describe("writeClipboardText", () => {
  test("returns success when the modern clipboard write resolves", async () => {
    const writeText = mock(async () => undefined);
    const execCommand = mock(() => true);
    installClipboard(writeText);
    installDocument(execCommand);

    expect(await writeClipboardText("modern")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("modern");
    expect(execCommand).not.toHaveBeenCalled();
  });

  test("returns failure when the clipboard and fallback are unavailable", async () => {
    globals.navigator = {} as Navigator;
    const document = installDocument();

    expect(await writeClipboardText("missing")).toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  test("contains a synchronous modern failure and tries the fallback", async () => {
    const writeText = mock(() => {
      throw new Error("blocked");
    });
    const execCommand = mock(() => true);
    installClipboard(writeText as unknown as (text: string) => Promise<void>);
    installDocument(execCommand);

    expect(await writeClipboardText("sync failure")).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  test("contains a rejected modern write and tries the fallback", async () => {
    const writeText = mock(async () => {
      throw new Error("denied");
    });
    const execCommand = mock(() => true);
    installClipboard(writeText);
    installDocument(execCommand);

    expect(await writeClipboardText("rejected")).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  test("copies through the fallback and removes its textarea", async () => {
    globals.navigator = {} as Navigator;
    let selectedValue = "";
    const document = installDocument(() => {
      selectedValue = (document.querySelector("textarea") as HTMLTextAreaElement).value;
      return true;
    });

    expect(await writeClipboardText("legacy")).toBe(true);
    expect(selectedValue).toBe("legacy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  test("returns failure and cleans up when the fallback returns false", async () => {
    globals.navigator = {} as Navigator;
    const document = installDocument(() => false);

    expect(await writeClipboardText("not copied")).toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  test("contains a throwing fallback and removes its textarea", async () => {
    globals.navigator = {} as Navigator;
    const document = installDocument(() => {
      throw new Error("unsupported");
    });

    expect(await writeClipboardText("throwing fallback")).toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });
});
