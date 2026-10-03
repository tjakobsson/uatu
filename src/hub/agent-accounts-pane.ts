/**
 * Settings → Agent accounts, the client side (hub-dashboard: Settings
 * manages agent accounts; agent-accounts capability).
 *
 * Inlined into the Settings page the way `dashboard-groups.ts` is: the
 * function is stringified, so it must stay self-contained. It may reference
 * nothing outside its own body, and its types are declared inside it.
 *
 * It reads `GET /api/hub/agent-accounts` and renders one collapsed card per
 * agent:
 * - Claude Code: its account, both login methods, and log out.
 * - OpenCode: its providers, logged-in first, the rest findable by name.
 *
 * A started login shows the way it is finished: a device code to enter, a
 * code to paste back, or the address a localhost redirect landed on. While an
 * agent is starting or a login is pending the page polls once a second, and
 * it re-renders only when the answer changed, keeping typed values and focus,
 * so a poll never wipes a half-typed key.
 *
 * Secrets typed here (keys, codes, addresses) are posted once and never kept:
 * a successful submit drops them, and no answer from the Hub carries one.
 */
export function createAgentAccountsPane() {
  type FieldCondition = { key: string; op: "eq" | "neq"; value: string };
  type Field = {
    key: string;
    label: string;
    kind: "text" | "select";
    valueType: string;
    required: boolean;
    secret?: boolean;
    placeholder?: string;
    description?: string;
    options?: Array<{ value: string; label: string; hint?: string }>;
    when?: FieldCondition[];
  };
  type Method =
    | { id: string; kind: "key"; label: string; fields: Field[] }
    | { id: string; kind: "oauth"; label: string; fields: Field[]; completion?: string }
    | { id: string; kind: "env"; label: string; variables: string[] }
    | { id: string; kind: "command"; label: string; command: string };
  type Credential = { id: string; label: string; kind: string; active: boolean; removable: boolean; variables?: string[]; status?: string };
  type Target = { id: string; name: string; connected: boolean; credentials: Credential[]; methods: Method[] };
  type ClaudeState = { source: string; email?: string; organization?: string; plan?: string; provider?: string };
  type Agent = {
    agent: string;
    name: string;
    state: string;
    version?: string;
    generation?: number;
    message?: string;
    capabilities: { login: boolean; logout: boolean; activate: boolean };
    targets: Target[];
    claude?: ClaudeState;
    methods: Method[];
    loginCommand: string;
  };
  type Attempt = {
    id: string;
    agent: string;
    target: string;
    methodId: string;
    url: string;
    instructions: string;
    completion: "device" | "code" | "redirect";
    state: "pending" | "complete" | "failed" | "expired" | "cancelled";
    message?: string;
    startedAt: number;
    expiresAt: number;
  };
  type Snapshot = { agents: Agent[]; attempts: Attempt[] };

  const API = "/api/hub/agent-accounts";
  const POLL_MS = 1_000;
  const root = document.getElementById("agent-accounts")!;
  const meta = document.getElementById("agent-accounts-meta");
  const loadError = document.getElementById("agent-accounts-error");
  let snapshot: Snapshot | null = null;
  let rendered = "";
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  // Disclosure state by key ("agent:claude", "provider:opencode:groq",
  // "all:opencode"), kept across re-renders.
  const openKeys = new Set<string>();
  // Errors shown next to the control that caused them, by control key.
  const errors = new Map<string, string>();
  // Controls with a request in flight, by control key, with their busy label.
  const busy = new Map<string, string>();
  // The answers a login started with, so "Start again" asks nothing twice.
  // Never a key, code, address, or a field the agent marked secret.
  const startedWith = new Map<string, Record<string, string>>();
  let filter = "";

  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const code = (text: string) => make("code", undefined, text);
  const option = (text: string, value: string) => {
    const node = make("option", undefined, text);
    node.value = value;
    return node;
  };
  // Inputs by their keep key, without building a selector from the key.
  const keptInputs = (keep: string) => [...root.querySelectorAll<HTMLInputElement>("[data-keep]")].filter(input => input.dataset.keep === keep);
  const paragraph = (className: string, ...parts: Array<string | Node>) => {
    const node = make("p", className);
    node.append(...parts);
    return node;
  };

  async function call(path: string, body?: unknown): Promise<Snapshot> {
    const response = await fetch(path, body === undefined
      ? { headers: { accept: "application/json" } }
      : { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({})) as { error?: string; field?: string } & Partial<Snapshot>;
    if (!response.ok) {
      const error = new Error(payload.error || "The request failed (" + response.status + ").") as Error & { field?: string };
      if (payload.field) error.field = payload.field;
      throw error;
    }
    return payload as Snapshot;
  }

  function needsPolling(): boolean {
    if (!snapshot) return false;
    return snapshot.agents.some(agent => agent.state === "starting" || agent.state === "idle")
      || snapshot.attempts.some(attempt => attempt.state === "pending");
  }

  function schedule(): void {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
    if (!needsPolling()) return;
    pollTimer = setTimeout(() => { void load(); }, POLL_MS);
  }

  function accept(next: Snapshot): void {
    snapshot = next;
    // Settled attempts the Hub no longer reports leave the page too.
    render();
    schedule();
  }

  async function load(): Promise<void> {
    try {
      const next = await call(API);
      if (loadError) { loadError.hidden = true; loadError.textContent = ""; }
      accept(next);
    } catch (error) {
      if (loadError) {
        loadError.hidden = false;
        loadError.textContent = "Agent accounts could not be loaded: " + (error instanceof Error ? error.message : String(error));
      }
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = setTimeout(() => { void load(); }, POLL_MS * 5);
    }
  }

  /** Runs one mutation for a control: busy label, contextual error, fresh render. */
  async function act(key: string, busyLabel: string, path: string, body: unknown, after?: () => void): Promise<boolean> {
    if (busy.has(key)) return false;
    busy.set(key, busyLabel);
    errors.delete(key);
    render(true);
    try {
      const next = await call(path, body);
      busy.delete(key);
      after?.();
      accept(next);
      return true;
    } catch (error) {
      busy.delete(key);
      errors.set(key, error instanceof Error ? error.message : String(error));
      render(true);
      return false;
    }
  }

  // ---- rendering ---------------------------------------------------------

  /** Typed values and focus survive a re-render; a dropped key starts empty. */
  function preserve(): { values: Map<string, string>; focus: string | null; selection: [number, number] | null } {
    const values = new Map<string, string>();
    for (const input of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-keep]")) values.set(input.dataset.keep!, input.value);
    const active = document.activeElement as HTMLInputElement | null;
    const focus = active && root.contains(active) ? active.dataset?.keep ?? null : null;
    let selection: [number, number] | null = null;
    if (focus && active && typeof active.selectionStart === "number" && typeof active.selectionEnd === "number") selection = [active.selectionStart, active.selectionEnd];
    return { values, focus, selection };
  }

  function restore(state: ReturnType<typeof preserve>): void {
    for (const input of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-keep]")) {
      const value = state.values.get(input.dataset.keep!);
      if (value !== undefined) input.value = value;
    }
    for (const form of root.querySelectorAll<HTMLElement>("[data-fields]")) applyConditions(form);
    if (state.focus) {
      const target = keptInputs(state.focus)[0];
      if (target) {
        target.focus();
        if (state.selection) {
          try { target.setSelectionRange(state.selection[0], state.selection[1]); } catch { /* not a text input */ }
        }
      }
    }
  }

  function render(force = false): void {
    const key = JSON.stringify([snapshot, [...errors], [...busy], filter]);
    if (!force && key === rendered) return;
    rendered = key;
    const state = preserve();
    // Disclosure state is read back from the nodes about to be replaced: a
    // node's toggle event fires a task later, so a click followed at once by
    // typing would otherwise re-render before the open was recorded.
    for (const details of root.querySelectorAll<HTMLDetailsElement>("details[data-open-key]")) {
      if (details.open) openKeys.add(details.dataset.openKey!);
      else openKeys.delete(details.dataset.openKey!);
    }
    root.replaceChildren();
    if (!snapshot) {
      root.append(make("p", "empty", "Checking agent logins…"));
      return;
    }
    if (meta) meta.textContent = snapshot.agents.length + (snapshot.agents.length === 1 ? " agent" : " agents");
    for (const agent of snapshot.agents) root.append(agentCard(agent));
    restore(state);
  }

  function disclosure(openKey: string, className: string): HTMLDetailsElement {
    const details = make("details", className);
    details.dataset.openKey = openKey;
    details.open = openKeys.has(openKey);
    details.addEventListener("toggle", () => {
      if (details.open) openKeys.add(openKey);
      else openKeys.delete(openKey);
    });
    return details;
  }

  function errorLine(key: string): HTMLElement | null {
    const message = errors.get(key);
    if (!message) return null;
    const line = make("p", "local-error", message);
    line.setAttribute("role", "alert");
    return line;
  }

  function button(label: string, key: string, onClick: () => void, className = ""): HTMLButtonElement {
    const node = make("button", className, busy.get(key) ?? label);
    node.type = "button";
    node.disabled = busy.has(key);
    node.addEventListener("click", onClick);
    return node;
  }

  function claudeSummary(agent: Agent): string {
    const claude = agent.claude;
    if (!claude) return "Checking…";
    switch (claude.source) {
      case "subscription": return "Logged in as " + (claude.email ?? "a Claude account") + (claude.plan ? " · " + claude.plan : "");
      case "console": return "Logged in as " + (claude.email ?? "an Anthropic Console account") + " · Anthropic Console";
      case "env-api-key": return "API key from ANTHROPIC_API_KEY";
      case "env-token": return "Token from the Hub's environment";
      case "api-key-helper": return "Key from an apiKeyHelper";
      case "third-party": return "Through " + (claude.provider ?? "a third-party provider");
      case "none": return "Not logged in";
      default: return "Login state unknown";
    }
  }

  // Logged in through a login the user made, not a built-in free provider.
  function loggedInTargets(agent: Agent): Target[] {
    return agent.targets.filter(target => target.connected && target.credentials.some(credential => credential.kind !== "other"));
  }

  function agentSummary(agent: Agent): { text: string; chip: string; ok: boolean } {
    if (agent.state === "not-installed") return { text: "Not installed", chip: "Not installed", ok: false };
    if (agent.state === "unavailable") return { text: agent.message ?? "Unavailable", chip: "Unavailable", ok: false };
    if (agent.state !== "ready" && !agent.claude && agent.targets.length === 0) return { text: "Checking…", chip: "Checking", ok: false };
    if (agent.agent === "claude") {
      const source = agent.claude?.source;
      const ok = source !== undefined && source !== "none" && source !== "unknown";
      return { text: claudeSummary(agent), chip: ok ? "Logged in" : "Not logged in", ok };
    }
    const count = loggedInTargets(agent).length;
    const text = count === 0 ? "No provider logged in" : count === 1 ? "1 provider logged in" : count + " providers logged in";
    return { text, chip: count === 0 ? "Not logged in" : "Logged in", ok: count > 0 };
  }

  function agentCard(agent: Agent): HTMLElement {
    const card = disclosure("agent:" + agent.agent, "credential-card agent-account-card");
    card.id = "agent-accounts-" + agent.agent;
    card.dataset.agent = agent.agent;
    const summary = make("summary");
    const head = make("div", "credential-head");
    const status = agentSummary(agent);
    head.append(make("span", "indicator-dot" + (status.ok ? " is-live" : "")));
    head.append(make("strong", undefined, agent.name));
    const chips = make("span", "credential-state");
    chips.append(make("span", "chip" + (status.ok ? " is-ready" : agent.state === "starting" ? "" : " is-warn"), status.chip));
    head.append(chips);
    summary.append(head, make("p", "credential-summary agent-account-summary", status.text));
    card.append(summary);
    const body = make("div", "credential-body");
    card.append(body);
    if (agent.state === "not-installed" || agent.state === "unavailable") {
      const problem = make("p", "local-error", agent.message ?? (agent.name + " is not available."));
      problem.setAttribute("role", "alert");
      body.append(problem);
      body.append(paragraph("row-detail", "Install " + agent.name + " on the Hub machine, then reload this page."));
      return card;
    }
    if (agent.state !== "ready" && !agent.claude && agent.targets.length === 0) {
      body.append(make("p", "empty", "Starting " + agent.name + " to read its logins…"));
      return card;
    }
    if (agent.version) body.append(paragraph("row-detail agent-account-version", agent.name + " " + agent.version));
    if (agent.agent === "claude") renderClaude(agent, body);
    else renderOpenCode(agent, body);
    return card;
  }

  // ---- Claude Code ------------------------------------------------------

  function renderClaude(agent: Agent, body: HTMLElement): void {
    const claude = agent.claude ?? { source: "unknown" };
    const account = make("section", "credential-section");
    account.append(make("h3", undefined, "Account"));
    const facts = make("dl", "agent-account-facts");
    const fact = (term: string, value: string | undefined) => {
      if (!value) return;
      facts.append(make("dt", undefined, term), make("dd", undefined, value));
    };
    const HOW: Record<string, string> = {
      subscription: "Claude subscription",
      console: "Anthropic Console account",
      "env-api-key": "API key from the Hub's environment",
      "env-token": "Token from the Hub's environment",
      "api-key-helper": "apiKeyHelper",
      "third-party": "Third-party provider" + (claude.provider ? " (" + claude.provider + ")" : ""),
      none: "Not logged in",
    };
    fact("Login", HOW[claude.source] ?? "Unknown");
    fact("Email", claude.email);
    fact("Organization", claude.organization);
    fact("Plan", claude.plan);
    account.append(facts);
    if (claude.source === "env-api-key") {
      account.append(paragraph("row-detail", "A key in the Hub's environment (", code("ANTHROPIC_API_KEY"), ") is in effect. A browser login does not take effect while it is set."));
    } else if (claude.source === "env-token" || claude.source === "api-key-helper") {
      account.append(paragraph("row-detail", "This login is configured in the Hub's environment or Claude Code's settings, not here."));
    } else if (claude.source === "third-party") {
      account.append(paragraph("row-detail", "Claude Code uses " + (claude.provider ?? "a third-party provider") + ", configured outside UatuCode."));
    }
    body.append(account);

    const target = "claude";
    const login = make("section", "credential-section");
    const loggedIn = claude.source === "subscription" || claude.source === "console";
    login.append(make("h3", undefined, loggedIn ? "Log in with another account" : "Log in"));
    const attempt = latestAttempt(agent.agent, target);
    if (attempt && attempt.state === "pending") {
      login.append(attemptView(agent, attempt)!);
    } else {
      if (attempt) { const settled = attemptView(agent, attempt); if (settled) login.append(settled); }
      if (agent.capabilities.login && agent.methods.length) {
        const actions = make("div", "agent-account-actions");
        for (const method of agent.methods) {
          const key = "login:" + agent.agent + ":" + target + ":" + method.id;
          actions.append(button(method.label, key, () => { void startLogin(agent, target, method, {}, key); }, loggedIn ? "" : "primary"));
        }
        login.append(actions);
        for (const method of agent.methods) {
          const line = errorLine("login:" + agent.agent + ":" + target + ":" + method.id);
          if (line) login.append(line);
        }
      } else {
        login.append(paragraph("row-detail", "Run ", code(agent.loginCommand), " on the Hub machine."));
      }
    }
    body.append(login);

    if (agent.capabilities.logout) {
      const out = make("section", "credential-section agent-account-logout");
      const key = "logout:" + agent.agent + ":" + target;
      out.append(button("Log out of " + agent.name, key, () => { void logout(agent, target, target, agent.name, key); }, "danger"));
      const line = errorLine(key);
      if (line) out.append(line);
      body.append(out);
    }
  }

  // ---- OpenCode ---------------------------------------------------------

  function renderOpenCode(agent: Agent, body: HTMLElement): void {
    const connected = agent.targets.filter(target => target.connected);
    const others = agent.targets.filter(target => !target.connected);
    const list = make("section", "credential-section");
    list.append(make("h3", undefined, "Logged in"));
    if (connected.length === 0) list.append(make("p", "row-detail", "No provider is logged in."));
    for (const target of connected) list.append(providerCard(agent, target));
    body.append(list);

    const more = make("section", "credential-section");
    more.append(make("h3", undefined, "Log in to a provider"));
    const search = make("input", "agent-provider-filter");
    search.type = "text";
    search.setAttribute("enterkeyhint", "search");
    search.autocomplete = "off";
    search.placeholder = "Find a provider";
    search.setAttribute("aria-label", "Find a provider");
    search.dataset.keep = "filter:" + agent.agent;
    search.value = filter;
    search.addEventListener("input", () => {
      filter = search.value;
      render();
    });
    more.append(search);
    const query = filter.trim().toLowerCase();
    if (query) {
      const matches = agent.targets.filter(target => target.name.toLowerCase().includes(query) || target.id.toLowerCase().includes(query));
      if (matches.length === 0) more.append(make("p", "row-detail", "No provider matches “" + filter.trim() + "”."));
      for (const target of matches) more.append(providerCard(agent, target));
    } else {
      const all = disclosure("all:" + agent.agent, "agent-provider-all");
      all.append(make("summary", undefined, "All providers (" + others.length + ")"));
      for (const target of others) all.append(providerCard(agent, target));
      more.append(all);
    }
    body.append(more);
  }

  const KIND_LABELS: Record<string, string> = {
    key: "API key",
    oauth: "Browser login",
    saved: "Saved login",
    env: "Environment",
    config: "Configuration",
    other: "Built in",
  };

  function providerCard(agent: Agent, target: Target): HTMLElement {
    const card = disclosure("provider:" + agent.agent + ":" + target.id, "agent-provider");
    card.dataset.provider = target.id;
    const summary = make("summary");
    summary.append(make("span", "indicator-dot" + (target.connected ? " is-live" : "")), make("span", "agent-provider-name", target.name));
    const kinds = [...new Set(target.credentials.map(credential => KIND_LABELS[credential.kind] ?? credential.kind))];
    summary.append(make("span", "chip" + (target.connected ? " is-ready" : ""), target.connected ? (kinds.join(" · ") || "Logged in") : "Not logged in"));
    card.append(summary);
    const body = make("div", "agent-provider-body");
    card.append(body);

    for (const credential of target.credentials) body.append(credentialRow(agent, target, credential));

    const attempt = latestAttempt(agent.agent, target.id);
    if (attempt && attempt.state === "pending") {
      body.append(attemptView(agent, attempt)!);
      return card;
    }
    if (attempt) { const settled = attemptView(agent, attempt); if (settled) body.append(settled); }
    for (const method of target.methods) body.append(methodBlock(agent, target, method));
    return card;
  }

  function credentialRow(agent: Agent, target: Target, credential: Credential): HTMLElement {
    const row = make("div", "agent-credential");
    const kind = KIND_LABELS[credential.kind] ?? credential.kind;
    row.append(make("span", "agent-credential-label", credential.label));
    if (kind !== credential.label) row.append(make("span", "chip", kind));
    if (target.credentials.length > 1 && credential.active) row.append(make("span", "chip is-ready", "Active"));
    if (credential.variables?.length) {
      const where = make("span", "row-detail");
      where.append("from ");
      credential.variables.forEach((name, index) => { if (index) where.append(", "); where.append(code(name)); });
      row.append(where);
    }
    if (credential.status) row.append(make("span", "chip is-warn", credential.status));
    const actions = make("span", "agent-credential-actions");
    if (agent.capabilities.activate && credential.removable && !credential.active) {
      const key = "activate:" + agent.agent + ":" + credential.id;
      actions.append(button("Make active", key, () => { void act(key, "Switching…", API + "/activate", { agent: agent.agent, credential: credential.id }); }));
    }
    if (agent.capabilities.logout && credential.removable) {
      const key = "logout:" + agent.agent + ":" + target.id + ":" + credential.id;
      actions.append(button("Log out", key, () => { void logout(agent, target.id, credential.id, target.name, key); }, "danger"));
    }
    if (actions.childElementCount) row.append(actions);
    const wrap = make("div", "agent-credential-wrap");
    wrap.append(row);
    for (const key of ["activate:" + agent.agent + ":" + credential.id, "logout:" + agent.agent + ":" + target.id + ":" + credential.id]) {
      const line = errorLine(key);
      if (line) wrap.append(line);
    }
    if (!credential.removable && (credential.kind === "env" || credential.kind === "config")) {
      wrap.append(paragraph("row-detail", credential.kind === "env" ? "Set in the Hub's environment; change it there." : "Set in " + agent.name + "'s configuration; change it there."));
    }
    return wrap;
  }

  // ---- methods and fields -----------------------------------------------

  function fieldControl(formKey: string, field: Field): HTMLElement {
    const label = make("label", "agent-field");
    label.dataset.fieldKey = field.key;
    if (field.when?.length) label.dataset.when = JSON.stringify(field.when);
    label.append(field.label + (field.required ? "" : " (optional)"));
    let control: HTMLInputElement | HTMLSelectElement;
    if (field.kind === "select" && field.options) {
      const select = make("select");
      if (!field.required) select.append(option("—", ""));
      for (const choice of field.options) select.append(option(choice.hint ? choice.label + " — " + choice.hint : choice.label, choice.value));
      control = select;
    } else {
      const input = make("input");
      input.type = field.secret ? "password" : "text";
      input.autocomplete = "off";
      if (field.placeholder) input.placeholder = field.placeholder;
      control = input;
    }
    control.name = field.key;
    control.dataset.keep = formKey + ":" + field.key;
    label.append(control);
    if (field.description) label.append(make("span", "row-detail agent-field-description", field.description));
    return label;
  }

  function answersOf(form: HTMLElement): Record<string, string> {
    const answers: Record<string, string> = {};
    for (const label of form.querySelectorAll<HTMLElement>("[data-field-key]")) {
      if (label.hidden) continue;
      const control = label.querySelector<HTMLInputElement | HTMLSelectElement>("input, select");
      if (control && control.value.trim()) answers[label.dataset.fieldKey!] = control.value;
    }
    return answers;
  }

  /** Shows each field only while its conditions hold against the answers above it. */
  function applyConditions(form: HTMLElement): void {
    const values: Record<string, string> = {};
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-field-key] input, [data-field-key] select")) values[control.name] = control.value;
    for (const label of form.querySelectorAll<HTMLElement>("[data-when]")) {
      const conditions = JSON.parse(label.dataset.when!) as FieldCondition[];
      label.hidden = !conditions.every(condition => condition.op === "eq" ? (values[condition.key] ?? "") === condition.value : (values[condition.key] ?? "") !== condition.value);
    }
  }

  function methodBlock(agent: Agent, target: Target, method: Method): HTMLElement {
    const block = make("div", "agent-method");
    block.dataset.method = method.id;
    if (method.kind === "env") {
      const line = paragraph("row-detail", "Set ");
      method.variables.forEach((name, index) => { if (index) line.append(" or "); line.append(code(name)); });
      line.append(" in the Hub's environment, then restart the Hub.");
      block.append(make("p", "agent-method-label", method.label), line);
      return block;
    }
    if (method.kind === "command") {
      block.append(make("p", "agent-method-label", method.label), paragraph("row-detail", "Run ", code(method.command), " on the Hub machine."));
      return block;
    }
    const formKey = method.kind + ":" + agent.agent + ":" + target.id + ":" + method.id;
    const form = make("form", "form-stack agent-method-form");
    form.dataset.fields = "";
    form.noValidate = true;
    form.append(make("p", "agent-method-label", method.label));
    for (const field of method.fields) form.append(fieldControl(formKey, field));
    let keyInput: HTMLInputElement | null = null;
    if (method.kind === "key") {
      const label = make("label", "agent-field");
      label.append("Key");
      keyInput = make("input");
      keyInput.type = "password";
      keyInput.autocomplete = "off";
      keyInput.name = "key";
      keyInput.dataset.keep = formKey + ":key";
      label.append(keyInput);
      form.append(label);
    }
    const line = errorLine(formKey);
    if (line) form.append(line);
    const submit = make("button", "primary", busy.get(formKey) ?? (method.kind === "key" ? "Save key" : "Log in"));
    submit.type = "submit";
    submit.disabled = busy.has(formKey);
    const row = make("div");
    row.append(submit);
    form.append(row);
    form.addEventListener("input", () => applyConditions(form));
    form.addEventListener("change", () => applyConditions(form));
    form.addEventListener("submit", event => {
      event.preventDefault();
      const answers = answersOf(form);
      if (method.kind === "key") {
        const key = keyInput!.value;
        if (!key.trim()) {
          errors.set(formKey, "Enter a key.");
          render(true);
          return;
        }
        void act(formKey, "Saving…", API + "/key", { agent: agent.agent, target: target.id, method: method.id, key, ...(Object.keys(answers).length ? { answers } : {}) }, () => {
          // Saved: the key is dropped from the page, not kept for the next render.
          keyInput!.value = "";
          for (const input of keptInputs(formKey + ":key")) input.value = "";
          clearSecrets(formKey, method);
        });
      } else {
        void startLogin(agent, target.id, method, answers, formKey);
      }
    });
    applyConditions(form);
    block.append(form);
    return block;
  }

  // ---- attempts ---------------------------------------------------------

  function latestAttempt(agent: string, target: string): Attempt | undefined {
    const attempts = (snapshot?.attempts ?? []).filter(attempt => attempt.agent === agent && attempt.target === target && attempt.state !== "cancelled");
    return attempts.sort((a, b) => b.startedAt - a.startedAt)[0];
  }

  function secretFields(method: Method): Field[] {
    return method.kind === "key" || method.kind === "oauth" ? method.fields.filter(field => field.secret) : [];
  }

  /** Drops the answers to a method's secret fields from the page once they were sent. */
  function clearSecrets(formKey: string, method: Method): void {
    for (const field of secretFields(method)) for (const input of keptInputs(formKey + ":" + field.key)) input.value = "";
  }

  async function startLogin(agent: Agent, target: string, method: Method, answers: Record<string, string>, key: string): Promise<void> {
    const kept = { ...answers };
    for (const field of secretFields(method)) delete kept[field.key];
    startedWith.set(agent.agent + ":" + target + ":" + method.id, kept);
    const formKey = method.kind + ":" + agent.agent + ":" + target + ":" + method.id;
    await act(key, "Starting…", API + "/login", { agent: agent.agent, target, method: method.id, ...(Object.keys(answers).length ? { answers } : {}) }, () => clearSecrets(formKey, method));
  }

  /**
   * "Start again" for a method with a secret field: its answer was not kept,
   * so the method's form below asks for it again instead of starting blind.
   */
  function askAgain(agent: Agent, target: string, method: Method): void {
    const formKey = method.kind + ":" + agent.agent + ":" + target + ":" + method.id;
    const labels = secretFields(method).map(field => field.label);
    errors.set(formKey, "Enter " + labels.join(" and ") + " again, then log in.");
    render(true);
    // The other answers come back as they were, so only the secret is typed again.
    for (const [key, value] of Object.entries(startedWith.get(agent.agent + ":" + target + ":" + method.id) ?? {})) {
      for (const input of keptInputs(formKey + ":" + key)) if (!input.value) input.value = value;
    }
    const first = secretFields(method)[0];
    const input = first ? keptInputs(formKey + ":" + first.key)[0] : undefined;
    const form = input?.closest<HTMLElement>("[data-fields]");
    if (form) applyConditions(form);
    input?.focus();
  }

  async function logout(agent: Agent, target: string, credential: string, name: string, key: string): Promise<void> {
    const confirmed = window.confirm("Log out of " + name + "?\n\nEvery workspace on this Hub, every user of this Hub, and " + agent.name + " itself on this machine lose this login.");
    if (!confirmed) return;
    await act(key, "Logging out…", API + "/logout", { agent: agent.agent, target, credential });
  }

  // A device code inside the agent's instructions ("Enter code: ABCD-1234").
  function deviceCode(instructions: string): string | null {
    const match = /code[:\s]+([A-Z0-9]{4,}(?:-[A-Z0-9]{2,})*)/i.exec(instructions);
    return match ? match[1]! : null;
  }

  function signInLink(url: string, text: string): HTMLAnchorElement {
    const link = make("a", "agent-attempt-link", text);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  }

  function clock(epoch: number): string {
    const date = new Date(epoch);
    return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
  }

  function attemptView(agent: Agent, attempt: Attempt): HTMLElement | null {
    const view = make("div", "agent-attempt is-" + attempt.state);
    view.dataset.attemptId = attempt.id;
    view.dataset.completion = attempt.completion;
    const methodKey = attempt.agent + ":" + attempt.target + ":" + attempt.methodId;
    const restart = () => {
      const method = (agent.agent === "claude" ? agent.methods : agent.targets.find(target => target.id === attempt.target)?.methods ?? []).find(candidate => candidate.id === attempt.methodId);
      const key = "restart:" + attempt.id;
      const node = button("Start again", key, () => {
        if (!method) return;
        if (secretFields(method).length) askAgain(agent, attempt.target, method);
        else void startLogin(agent, attempt.target, method, startedWith.get(methodKey) ?? {}, key);
      });
      node.disabled = node.disabled || !method;
      return node;
    };
    if (attempt.state === "complete") {
      const done = paragraph("agent-attempt-done", "Logged in.");
      done.setAttribute("role", "status");
      view.append(done);
      return view;
    }
    if (attempt.state === "failed" || attempt.state === "expired") {
      const why = make("p", "local-error", attempt.state === "expired" ? "The login expired before it was finished." : (attempt.message ?? "The login failed."));
      why.setAttribute("role", "alert");
      view.append(why, restart());
      const line = errorLine("restart:" + attempt.id);
      if (line) view.append(line);
      return view;
    }
    if (attempt.state !== "pending") return null;

    if (attempt.completion === "device") {
      const shown = deviceCode(attempt.instructions);
      view.append(paragraph("agent-attempt-step", "Open ", signInLink(attempt.url, "the sign-in page"), shown ? " and enter this code:" : "."));
      if (shown) {
        const box = make("div", "agent-device-code");
        const value = make("output", "agent-device-code-value", shown);
        value.setAttribute("aria-label", "Code to enter");
        const copyKey = "copy:" + attempt.id;
        const copy = button("Copy", copyKey, () => {
          void navigator.clipboard?.writeText(shown).then(() => { copy.textContent = "Copied"; }, () => { copy.textContent = "Select and copy"; });
        });
        box.append(value, copy);
        view.append(box);
      } else if (attempt.instructions) {
        view.append(paragraph("row-detail", attempt.instructions));
      }
      const waiting = paragraph("row-detail agent-attempt-waiting", "Waiting for you to finish signing in…");
      waiting.setAttribute("role", "status");
      view.append(waiting);
    } else {
      view.append(paragraph("agent-attempt-step", signInLink(attempt.url, "Open the sign-in page")));
      if (attempt.completion === "code") {
        view.append(paragraph("row-detail", "Sign in, then paste the code the page shows."));
      } else {
        view.append(paragraph("row-detail", "After you sign in, the browser goes to an address starting with ", code("http://localhost"), ". Unless this device is the Hub machine, that page will not load. Copy the whole address from the address bar and paste it here."));
      }
      const formKey = "finish:" + attempt.id;
      const form = make("form", "form-stack agent-attempt-form");
      form.noValidate = true;
      const label = make("label", "agent-field");
      label.append(attempt.completion === "code" ? "Code" : "Address");
      const input = make("input");
      input.type = "text";
      input.autocomplete = "off";
      input.name = attempt.completion === "code" ? "code" : "address";
      input.dataset.keep = formKey;
      if (attempt.completion === "redirect") input.placeholder = "http://localhost:…";
      label.append(input);
      form.append(label);
      const line = errorLine(formKey);
      if (line) form.append(line);
      const submit = make("button", "primary", busy.get(formKey) ?? (attempt.completion === "code" ? "Submit code" : "Finish login"));
      submit.type = "submit";
      submit.disabled = busy.has(formKey);
      const row = make("div");
      row.append(submit);
      form.append(row);
      form.addEventListener("submit", event => {
        event.preventDefault();
        const value = input.value;
        if (!value.trim()) {
          errors.set(formKey, attempt.completion === "code" ? "Paste the code the sign-in page showed." : "Paste the address the browser landed on.");
          render(true);
          return;
        }
        const path = API + "/attempts/" + encodeURIComponent(attempt.id) + "/" + (attempt.completion === "code" ? "code" : "redirect");
        void act(formKey, "Submitting…", path, attempt.completion === "code" ? { code: value } : { address: value }, () => {
          for (const node of keptInputs(formKey)) node.value = "";
        });
      });
      view.append(form);
    }
    view.append(paragraph("row-detail", "This login expires at " + clock(attempt.expiresAt) + "."));
    const cancelKey = "cancel:" + attempt.id;
    view.append(button("Cancel", cancelKey, () => { void act(cancelKey, "Cancelling…", API + "/attempts/" + encodeURIComponent(attempt.id) + "/cancel", {}); }));
    const line = errorLine(cancelKey);
    if (line) view.append(line);
    return view;
  }

  // ---- deep link --------------------------------------------------------

  function openFromHash(): void {
    const match = /^#agent-accounts\/([A-Za-z0-9_-]+)$/.exec(location.hash);
    if (!match) return;
    openKeys.add("agent:" + match[1]);
    // The read-back in render() takes the open state from the node, so the
    // node is opened too.
    const existing = document.getElementById("agent-accounts-" + match[1]) as HTMLDetailsElement | null;
    if (existing) existing.open = true;
    render(true);
    document.getElementById("agent-accounts-" + match[1])?.scrollIntoView({ block: "start" });
  }

  window.addEventListener("hashchange", openFromHash);
  return {
    async start(): Promise<void> {
      if (/^#agent-accounts\//.test(location.hash)) openKeys.add("agent:" + location.hash.slice("#agent-accounts/".length));
      render(true);
      await load();
      openFromHash();
    },
    reload: load,
  };
}

export const agentAccountsPaneStyle = `
.agent-accounts-scope { margin: 0; padding: 0.65rem 1rem; color: var(--text-subtle); font-size: 0.78rem; border-bottom: 1px solid var(--border-soft); }
.agent-accounts-load-error { margin: 0.65rem 1rem; }
.agent-account-summary { margin: 0.25rem 0 0 1.25rem; color: var(--text-subtle); font-size: 0.76rem; overflow-wrap: anywhere; }
.agent-account-version { margin: 0; }
.agent-account-facts { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 0.75rem; margin: 0; font-size: 0.8rem; }
.agent-account-facts dt { color: var(--text-subtle); }
.agent-account-facts dd { margin: 0; overflow-wrap: anywhere; }
.agent-account-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.agent-provider-filter { margin-bottom: 0.5rem; }
.agent-provider, .agent-provider-all { border: 1px solid var(--border-soft); border-radius: 0.4rem; margin-bottom: 0.4rem; }
.agent-provider > summary, .agent-provider-all > summary { cursor: pointer; display: flex; align-items: center; gap: 0.5rem; padding: 0.45rem 0.65rem; font-size: 0.8rem; font-weight: 600; }
.agent-provider-all { border-style: dashed; }
.agent-provider-all > .agent-provider { margin: 0 0.5rem 0.4rem; }
.agent-provider-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.agent-provider-body { padding: 0 0.65rem 0.6rem; display: grid; gap: 0.5rem; }
.agent-credential { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; font-size: 0.8rem; }
.agent-credential-label { font-weight: 600; }
.agent-credential-actions { margin-left: auto; display: inline-flex; gap: 0.4rem; }
.agent-method { border-top: 1px solid var(--border-soft); padding-top: 0.5rem; }
.agent-method .form-stack, .agent-attempt .form-stack { padding: 0; }
.agent-method-label { margin: 0 0 0.25rem; font-size: 0.78rem; font-weight: 600; color: var(--text-strong); }
.agent-method p.row-detail, .agent-attempt p.row-detail { margin: 0.2rem 0; }
.agent-field-description { display: block; font-weight: 400; margin-top: 0.2rem; }
.agent-attempt { display: grid; gap: 0.5rem; padding: 0.65rem; border: 1px solid var(--accent); border-radius: 0.45rem; background: var(--surface-muted); }
.agent-attempt.is-failed, .agent-attempt.is-expired { border-color: var(--danger); }
.agent-attempt.is-complete { border-color: var(--success); }
.agent-attempt-step { margin: 0; font-size: 0.85rem; }
.agent-attempt-link { color: var(--accent); font-weight: 700; }
.agent-attempt-done { margin: 0; color: var(--success); font-weight: 600; }
.agent-device-code { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; }
.agent-device-code-value { font-family: var(--mono-font-family); font-size: 1.6rem; font-weight: 700; letter-spacing: 0.08em; color: var(--text-strong); user-select: all; }
.agent-attempt > button, .agent-account-logout > button { justify-self: start; }
.agent-account-logout { display: grid; gap: 0.35rem; }
.agent-accounts-pane code, #agent-accounts code { font-family: var(--mono-font-family); font-size: 0.92em; }
.agent-account-card .credential-head { flex-wrap: nowrap; align-items: center; }
.agent-account-card .credential-head strong { flex: 1 1 auto; }
@media (max-width: 520px) {
  .agent-account-card .credential-head { flex-wrap: nowrap; align-items: center; }
  .agent-account-card .credential-head strong { flex-basis: auto; }
  .agent-credential-actions { margin-left: 0; flex-basis: 100%; }
  .agent-credential-actions > button, .agent-account-actions > button { flex: 1 1 auto; }
  .agent-device-code-value { font-size: 1.9rem; }
  .agent-attempt-form button, .agent-method-form button { width: 100%; }
}
`;
