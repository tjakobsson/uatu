const states = new WeakMap<HTMLElement, { previous: boolean; reasons: Set<object> }>();

/** Each owner releases only its own reason; pre-existing inertness survives. */
export function setChatInert(element: HTMLElement, reason: object, active: boolean): void {
  let state = states.get(element);
  if (!state) {
    if (!active) return;
    state = { previous: element.hasAttribute("inert"), reasons: new Set() };
    states.set(element, state);
  }
  if (active) state.reasons.add(reason);
  else state.reasons.delete(reason);
  element.toggleAttribute("inert", state.previous || state.reasons.size > 0);
  if (!state.reasons.size) states.delete(element);
}
