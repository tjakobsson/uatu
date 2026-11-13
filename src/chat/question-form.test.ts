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
  // The primary button stays enabled: an unanswered or blank step is caught
  // by the submit path, which jumps to the missing panel and says what is
  // still owed (GitHub #520 critique — a greyed button named nobody).
  test("reveals and focuses custom text and trims its draft", () => {
    const form = renderForm();
    const toggle = form.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!;
    const editor = form.querySelector<HTMLElement>("[data-question-custom-editor]")!;
    const input = form.querySelector<HTMLInputElement>("[data-question-custom-input]")!;
    const primary = form.querySelector<HTMLButtonElement>("[data-question-primary]")!;
    // Recorded with its options: on touch the coordinated scroll owner is the
    // one that brings this field above the keyboard, so the focus must not
    // scroll as well — `preventScroll` is what keeps WebKit from jumping first.
    let focusOptions: FocusOptions | null | undefined;
    let focused = false;
    input.focus = (options?: FocusOptions) => { focused = true; focusOptions = options; };

    toggle.checked = true;
    syncQuestionControl(toggle, true);
    expect(editor.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(focused).toBe(true);
    expect(focusOptions).toEqual({ preventScroll: true });
    expect(primary.disabled).toBe(false);

    input.value = "   ";
    syncQuestionControl(input);
    expect(primary.disabled).toBe(false);
    expect(collectQuestionAnswers(form)).toEqual([[]]);
    input.value = "  a custom answer  ";
    syncQuestionControl(input);
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

  // GitHub #520: every tab of an all-optional step form wore the answered
  // tick from the start, because an optional question left empty counts as
  // answered for gating. The tick states a real choice; gating still treats
  // an optional empty as answerable.
  test("a step's tick states a real choice, not an optional question left empty", () => {
    const form = renderForm([
      choice({ header: "Scope", allowFreeForm: false, optional: true }),
      choice({ header: "Details", options: [{ label: "X", description: "" }], optional: true }),
    ]);
    const tabs = [...form.querySelectorAll<HTMLButtonElement>("[data-question-tab]")];
    expect(tabs.every(tab => !tab.classList.contains("is-answered"))).toBe(true);
    // Gating still accepts the all-empty form: optional questions are
    // answerable as-is.
    expect(form.querySelector<HTMLButtonElement>("[data-question-primary]")!.disabled).toBe(false);

    const first = form.querySelector<HTMLInputElement>('[data-question-panel="0"] [data-question-provider-option]')!;
    first.checked = true;
    syncQuestionControl(first);
    expect(tabs[0]!.classList.contains("is-answered")).toBe(true);
    expect(tabs[1]!.classList.contains("is-answered")).toBe(false);
  });

  // GitHub #520: the whole question used to be readable only inside the
  // one-line ellipsised tab strip — a provider family maps it into the
  // header — because the stepped legend was screen-reader-only. The legend
  // is the question's statement in the panel, visible and full, fronted by
  // the step's short label; the tab pill carries the same short label.
  test("the stepped panel states its question in a visible, full legend fronted by the label", () => {
    const form = renderForm([
      choice({ header: "Scope", prompt: "Should I include scope checks in this pass", allowFreeForm: false }),
      choice({ header: "Details", prompt: "How much detail do you want in the report", options: [{ label: "X", description: "" }] }),
    ]);
    for (const panel of [...form.querySelectorAll<HTMLElement>("[data-question-panel]")]) {
      const legend = panel.querySelector<HTMLElement>("legend")!;
      expect(legend.classList.contains("sr-only")).toBe(false);
      expect(legend.querySelector(".chat-question-step")?.textContent).toContain(panel.getAttribute("data-question-panel") === "0" ? "Scope" : "Details");
      expect(legend.querySelector(".chat-question-statement")?.textContent).toContain(panel.getAttribute("data-question-panel") === "0" ? "Should I include scope checks" : "How much detail");
    }
    // The tab pill names the step by the short label, not the long question.
    const tabs = [...form.querySelectorAll<HTMLButtonElement>("[data-question-tab]")];
    expect(tabs.map(tab => tab.textContent!.replace(", answered", ""))).toEqual(["Scope", "Details"]);
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

    expect(parent.closest("[data-chat-item-id]")?.textContent).toContain("Requested by Subagent");
    expect(child.closest("[data-chat-item-id]")?.textContent).not.toContain("Requested by a subagent");
    expect(collectQuestionAnswers(parent)).toEqual([["A"]]);
    expect(collectQuestionAnswers(child)).toEqual([["child answer"]]);
  });

  // A mirrored pending question renders in both surfaces (parent and
  // drill-down share item.id), so the panel id carries the rendering
  // surface's conversation: duplicate document ids would leave one form's
  // tabs pointing at the other's fieldset.
  test("panel ids are unique per rendered surface, and tabs point at their own fieldset", () => {
    const stepped = [
      choice({ header: "Scope", allowFreeForm: false }),
      choice({ header: "Details", options: [{ label: "X", description: "" }] }),
    ];
    const parent = renderForm(stepped, "child", "parent");
    const child = renderForm(stepped, "child", "child");
    const parentPanel = parent.querySelector<HTMLElement>("[data-question-panel]")!;
    const childPanel = child.querySelector<HTMLElement>("[data-question-panel]")!;
    expect(parentPanel.id).not.toBe(childPanel.id);
    expect(parent.querySelectorAll("[data-question-tab]")[0]!.getAttribute("aria-controls")).toBe(parentPanel.id);
    expect(child.querySelectorAll("[data-question-tab]")[0]!.getAttribute("aria-controls")).toBe(childPanel.id);
  });

  // An OpenCode-v2 field without a description maps to an empty header: the
  // pill, eyebrow, and announcements must still name the step — by the
  // question itself rather than an empty label.
  test("a step without a header is named by its prompt", () => {
    const form = renderForm([
      choice({ header: "", prompt: "Which surfaces should this pass cover", allowFreeForm: false }),
      choice({ header: "Details", options: [{ label: "X", description: "" }] }),
    ]);
    const tabs = [...form.querySelectorAll<HTMLButtonElement>("[data-question-tab]")];
    expect(tabs[0]!.textContent!.replace(", answered", "")).toBe("Which surfaces should this pass cover");
    expect(tabs[1]!.textContent!.replace(", answered", "")).toBe("Details");
    expect(form.querySelector(".chat-question-step")!.textContent).toContain("Which surfaces");
  });
});
