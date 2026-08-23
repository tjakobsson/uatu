import { beforeAll, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { ChatProjection } from "./projection";
import type { ConversationItem, StructuredQuestion } from "./types";

const dom = parseHTML("<!doctype html><html><body></body></html>");
beforeAll(() => {
  (globalThis as Record<string, unknown>).document = dom.document;
});

const { collectQuestionAnswers, showQuestionPanel, syncQuestionControl, syncQuestionForm } = await import("./question-form");
const { TimelineRenderer } = await import("./timeline-renderer");

const choice = (overrides: Partial<StructuredQuestion> = {}): StructuredQuestion => ({
  prompt: "Pick one",
  header: "Choice",
  options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }],
  multiple: false,
  allowFreeForm: true,
  ...overrides,
});

function renderForm(questions: StructuredQuestion[] = [choice()], owner = "parent", projectionId = owner): HTMLFormElement {
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  const item: ConversationItem = {
    id: "question:q1",
    type: "question",
    createdAt: 1,
    requestId: "q1",
    conversationId: owner,
    status: "pending",
    questions,
  };
  const projection: ChatProjection = {
    conversationId: projectionId,
    generation: "g1",
    sequence: 1,
    cursor: "cursor",
    status: "running",
    acceptedDrafts: [],
    queued: [],
    queueRevision: 0,
    configurationRevision: 0,
    items: [item],
  };
  new TimelineRenderer().render(host, projection, new Set());
  const form = host.querySelector<HTMLFormElement>("[data-question-form]")!;
  syncQuestionForm(form);
  return form;
}

describe("question form interactions", () => {
  test("reveals and focuses custom text but requires non-whitespace content", () => {
    const form = renderForm();
    const toggle = form.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!;
    const editor = form.querySelector<HTMLElement>("[data-question-custom-editor]")!;
    const input = form.querySelector<HTMLInputElement>("[data-question-custom-input]")!;
    const primary = form.querySelector<HTMLButtonElement>("[data-question-primary]")!;
    let focused = false;
    input.focus = () => { focused = true; };

    toggle.checked = true;
    syncQuestionControl(toggle, true);
    expect(editor.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(focused).toBe(true);
    expect(primary.disabled).toBe(true);

    input.value = "   ";
    syncQuestionControl(input);
    expect(primary.disabled).toBe(true);
    input.value = "  a custom answer  ";
    syncQuestionControl(input);
    expect(primary.disabled).toBe(false);
    expect(collectQuestionAnswers(form)).toEqual([["a custom answer"]]);
  });

  test("selecting a provider radio hides custom text without clearing its draft or submitting", () => {
    const form = renderForm();
    let submissions = 0;
    form.addEventListener("submit", event => { event.preventDefault(); submissions += 1; });
    const toggle = form.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!;
    const editor = form.querySelector<HTMLElement>("[data-question-custom-editor]")!;
    const input = form.querySelector<HTMLInputElement>("[data-question-custom-input]")!;
    const provider = form.querySelector<HTMLInputElement>('[data-question-provider-option][value="A"]')!;

    toggle.checked = true;
    syncQuestionControl(toggle, true);
    input.value = "draft";
    syncQuestionControl(input);
    provider.checked = true;
    syncQuestionControl(provider, true);

    expect(submissions).toBe(0);
    expect(toggle.checked).toBe(false);
    expect(editor.hidden).toBe(true);
    expect(input.value).toBe("draft");
    expect(collectQuestionAnswers(form)).toEqual([["A"]]);

    toggle.checked = true;
    syncQuestionControl(toggle, true);
    expect(provider.checked).toBe(false);
    expect(input.value).toBe("draft");
    expect(collectQuestionAnswers(form)).toEqual([["draft"]]);
  });

  test("a provider-only radio waits for the Answer action", () => {
    const form = renderForm([choice({ allowFreeForm: false })]);
    let submissions = 0;
    form.addEventListener("submit", event => { event.preventDefault(); submissions += 1; });
    const provider = form.querySelector<HTMLInputElement>("[data-question-provider-option]")!;
    provider.checked = true;
    syncQuestionControl(provider, true);

    expect(submissions).toBe(0);
    expect(form.querySelector<HTMLButtonElement>("[data-question-primary]")!.disabled).toBe(false);
    expect(collectQuestionAnswers(form)).toEqual([["A"]]);
  });

  test("combines ordered multi-select labels with one trimmed custom answer", () => {
    const form = renderForm([choice({ multiple: true })]);
    const providers = [...form.querySelectorAll<HTMLInputElement>("[data-question-provider-option]")];
    const toggle = form.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!;
    const input = form.querySelector<HTMLInputElement>("[data-question-custom-input]")!;
    providers.forEach(provider => { provider.checked = true; syncQuestionControl(provider); });
    toggle.checked = true;
    syncQuestionControl(toggle, true);
    input.value = "  C  ";
    syncQuestionControl(input);

    expect(collectQuestionAnswers(form)).toEqual([["A", "B", "C"]]);
    expect(collectQuestionAnswers(form).flat()).not.toContain("Type your own answer");

    toggle.checked = false;
    syncQuestionControl(toggle, true);
    expect(input.value).toBe("  C  ");
    expect(input.closest<HTMLElement>("[data-question-custom-editor]")!.hidden).toBe(true);
    expect(collectQuestionAnswers(form)).toEqual([["A", "B"]]);
  });

  test("keeps stepped answers ordered and revisitable before final confirmation", () => {
    const form = renderForm([
      choice({ header: "Scope", allowFreeForm: false }),
      choice({ header: "Details", options: [{ label: "X", description: "" }] }),
    ]);
    const panels = [...form.querySelectorAll<HTMLElement>("[data-question-panel]")];
    const first = panels[0]!.querySelector<HTMLInputElement>("[data-question-provider-option]")!;
    first.checked = true;
    syncQuestionControl(first);
    expect(form.querySelector<HTMLButtonElement>("[data-question-primary]")!.textContent).toBe("Next");

    showQuestionPanel(form, 1);
    const toggle = panels[1]!.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!;
    const input = panels[1]!.querySelector<HTMLInputElement>("[data-question-custom-input]")!;
    toggle.checked = true;
    syncQuestionControl(toggle, true);
    input.value = "  custom  ";
    syncQuestionControl(input);
    expect(form.querySelector<HTMLButtonElement>("[data-question-primary]")!.textContent).toBe("Answer");
    expect(form.querySelector<HTMLButtonElement>("[data-question-primary]")!.disabled).toBe(false);
    expect(collectQuestionAnswers(form)).toEqual([["A"], ["custom"]]);

    showQuestionPanel(form, 0);
    expect(first.checked).toBe(true);
    showQuestionPanel(form, 1);
    expect(input.value).toBe("  custom  ");
  });

  test("keeps mirrored parent and drill-down forms independent while retaining child ownership", () => {
    const parent = renderForm([choice()], "child", "parent");
    const child = renderForm([choice()], "child", "child");
    const parentOption = parent.querySelector<HTMLInputElement>("[data-question-provider-option]")!;
    const childToggle = child.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!;
    const childInput = child.querySelector<HTMLInputElement>("[data-question-custom-input]")!;
    parentOption.checked = true;
    syncQuestionControl(parentOption);
    childToggle.checked = true;
    syncQuestionControl(childToggle, true);
    childInput.value = "child answer";
    syncQuestionControl(childInput);

    expect(parent.closest("[data-chat-item-id]")?.textContent).toContain("Requested by a subagent");
    expect(child.closest("[data-chat-item-id]")?.textContent).not.toContain("Requested by a subagent");
    expect(collectQuestionAnswers(parent)).toEqual([["A"]]);
    expect(collectQuestionAnswers(child)).toEqual([["child answer"]]);
  });
});
