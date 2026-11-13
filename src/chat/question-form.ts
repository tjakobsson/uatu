function customControls(panel: HTMLElement): { toggle: HTMLInputElement | null; input: HTMLInputElement | null; editor: HTMLElement | null } {
  return {
    toggle: panel.querySelector<HTMLInputElement>("[data-question-custom-toggle]"),
    input: panel.querySelector<HTMLInputElement>("[data-question-custom-input]"),
    editor: panel.querySelector<HTMLElement>("[data-question-custom-editor]"),
  };
}

function panelAnswers(panel: HTMLElement): string[] {
  const answers = [...panel.querySelectorAll<HTMLInputElement>("[data-question-provider-option]")]
    .filter(input => input.checked)
    .map(input => input.value);
  const { toggle, input } = customControls(panel);
  const custom = toggle?.checked ? input?.value.trim() : "";
  if (custom) answers.push(custom);
  return answers;
}

function syncCustomEditor(panel: HTMLElement, focus: boolean): void {
  const { toggle, input, editor } = customControls(panel);
  if (!toggle || !input || !editor) return;
  editor.hidden = !toggle.checked;
  toggle.setAttribute("aria-expanded", String(toggle.checked));
  // `preventScroll` because the reveal is not ours to leave to the platform:
  // on touch the coordinated scroll owner brings this field — and the row
  // holding Answer and Reject with it — to the bottom of the band above the
  // keyboard. WebKit's own focus scroll only lands it somewhere else first,
  // which the owner then has to correct in view of the reader.
  if (toggle.checked && focus) input.focus({ preventScroll: true });
}

export function syncQuestionControl(input: HTMLInputElement, focusCustom = false): void {
  const panel = input.closest<HTMLElement>("[data-question-panel]");
  const form = input.form ?? input.closest<HTMLFormElement>("form");
  if (!panel || !form) return;

  if (input.matches("[data-question-provider-option][type=radio]")) {
    const { toggle } = customControls(panel);
    if (toggle) toggle.checked = false;
  } else if (input.matches("[data-question-custom-toggle][type=radio]") && input.checked) {
    panel.querySelectorAll<HTMLInputElement>("[data-question-provider-option][type=radio]").forEach(option => { option.checked = false; });
  }
  syncCustomEditor(panel, focusCustom && input.matches("[data-question-custom-toggle]"));
  syncQuestionForm(form);
}

export function collectQuestionAnswers(form: HTMLFormElement): string[][] {
  return [...form.querySelectorAll<HTMLElement>("[data-question-panel]")].map(panelAnswers);
}

export function syncQuestionForm(form: HTMLFormElement): void {
  const panels = [...form.querySelectorAll<HTMLElement>("[data-question-panel]")];
  if (panels.length === 0) return;
  const activeIndex = Math.max(0, panels.findIndex(panel => !panel.hidden));
  // A tab's tick states a real choice: an optional question left empty is
  // answerable as-is, but a tick for having made no selection would read as
  // if the form had been answered for you (GitHub #520 — every step of an
  // all-optional form wore a tick from the start).
  const selections = panels.map(panel => panelAnswers(panel).length > 0);
  form.querySelectorAll<HTMLButtonElement>("[data-question-tab]").forEach((tab, index) => {
    tab.setAttribute("aria-selected", String(index === activeIndex));
    tab.classList.toggle("is-active", index === activeIndex);
    tab.classList.toggle("is-answered", selections[index] === true);
  });
  const primary = form.querySelector<HTMLButtonElement>("[data-question-primary]");
  if (!primary) return;
  // The primary button never disables: an unanswered step is caught by the
  // submit path, which jumps to the missing panel and says what is still
  // owed — a greyed button named nobody and could not even be asked why.
  const last = activeIndex === panels.length - 1;
  primary.textContent = last ? "Answer" : "Next";
}

export function showQuestionPanel(form: HTMLFormElement, index: number): void {
  form.querySelectorAll<HTMLElement>("[data-question-panel]").forEach((panel, at) => { panel.hidden = at !== index; });
  syncQuestionForm(form);
}
