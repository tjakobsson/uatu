// Connection-status chip and build badge — the small status surface in the
// top-right of the shell. Extracted from `app.ts` so the shell's event /
// boot modules can call into the same DOM refs without re-querying.
//
// The module queries its DOM dependencies once at module-load (mirroring the
// pattern in `app.ts`) and throws if they aren't present. This is a hard
// contract: the shell relies on these elements existing in index.html, and a
// missing one is a build / template bug we want to surface loudly, not
// degrade silently.

import { appBasePath, workspaceIdFromBasePath } from "../shared/app-url";
import type { BuildSummary } from "../shared/types";
import type { LiveChannelStatus } from "./live-channel";
import { startWorkspaceSession } from "./hub-nav";
import { awaitConfirmedLive, onManualRecovery, requestManualRecovery } from "./live";
import { onCurrentSessionRunning } from "./session-running";

const connectionStateElementMaybe = document.querySelector<HTMLElement>("#connection-state");
const connectionLabelElementMaybe = connectionStateElementMaybe?.querySelector<HTMLElement>(".connection-label") ?? null;
const connectionErrorElementMaybe = document.querySelector<HTMLElement>("#connection-error");
const buildBadgeElementMaybe = document.querySelector<HTMLElement>("#build-badge");

if (!connectionStateElementMaybe || !connectionLabelElementMaybe || !connectionErrorElementMaybe || !buildBadgeElementMaybe) {
  throw new Error("uatu UI failed to initialize (connection)");
}

// Locally-scoped non-null aliases. TypeScript's narrowing from the
// throw-if-null guard above doesn't survive into function bodies (the
// hoisted function declarations sit outside the if-block's control-flow
// scope), so we re-alias to `T` here.
const connectionStateElement: HTMLElement = connectionStateElementMaybe;
const connectionLabelElement: HTMLElement = connectionLabelElementMaybe;
const connectionErrorElement: HTMLElement = connectionErrorElementMaybe;
const buildBadgeElement: HTMLElement = buildBadgeElementMaybe;

export type ConnectionRawState = "live" | "reconnecting" | "connecting";

// What the indicator shows: the channel's state, except that a session the
// hub reports stopped reads `Stopped` for as long as the channel cannot
// confirm live. `Connected` wins over the flag — it is backed by state the
// page applied, which only a running child can have sent.
export type ConnectionDisplayState = ConnectionRawState | "stopped";

export function connectionDisplayState(raw: ConnectionRawState, sessionStopped: boolean): ConnectionDisplayState {
  if (raw === "live") return "live";
  return sessionStopped ? "stopped" : raw;
}

let connectionRawState: ConnectionRawState = "connecting";
let sessionStopped = false;

export function setConnectionState(state: ConnectionRawState, _label: string) {
  // The label argument is preserved for source-call clarity but the actual
  // display text is derived in syncConnectionDisplay.
  connectionRawState = state;
  if (state === "live") clearConnectionError();
  syncConnectionDisplay();
}

function clearConnectionError() {
  connectionErrorElement.textContent = "";
  connectionErrorElement.hidden = true;
}

function showConnectionError(message: string) {
  connectionErrorElement.textContent = message;
  connectionErrorElement.hidden = false;
}

function syncConnectionDisplay() {
  const state = connectionDisplayState(connectionRawState, sessionStopped);
  connectionStateElement.classList.remove("is-live", "is-reconnecting", "is-connecting", "is-stopped");
  connectionStateElement.classList.add(`is-${state}`);
  let label: string;
  let title: string;
  let action: string;
  if (state === "stopped") {
    label = "Stopped";
    title = "The workspace session is stopped";
    action = "Start the workspace session";
  } else if (state === "reconnecting") {
    label = "Reconnecting";
    title = "Reconnecting to the uatu backend";
    action = "Reconnect to the uatu backend";
  } else if (state === "connecting") {
    label = "Connecting";
    title = "Connecting to the uatu backend";
    action = "Reconnect to the uatu backend";
  } else {
    label = "Connected";
    title = "Connected to the uatu backend";
    action = title;
  }
  connectionLabelElement.textContent = label;
  connectionStateElement.title = title;
  // The title keeps naming the state — it is what a mouse user hovers for,
  // and it is the string the e2e locators read. The accessible name names
  // the ACTION instead, because that is what activating the control does;
  // only while live, when the control is inert, do the two agree.
  connectionStateElement.setAttribute("aria-label", action);
  // `aria-disabled`, not `disabled`: a disabled button leaves the tab order
  // and stops showing its tooltip, and the state is still worth reading
  // while the connection is healthy.
  connectionStateElement.setAttribute("aria-disabled", state === "live" ? "true" : "false");
}

// The shell's half of the manual recovery. The Chat surface offers the same
// action on its interruption line; both call the one `requestManualRecovery`,
// which joins an attempt already in flight rather than starting a second.
// While the session is stopped the same control starts it instead: a
// reconnect cannot bring back a child nobody has started.
connectionStateElement.addEventListener("click", () => {
  const state = connectionDisplayState(connectionRawState, sessionStopped);
  if (state === "live") return;
  if (state === "stopped") {
    void startStoppedSession();
    return;
  }
  void requestManualRecovery();
});

// Both the manual recovery and a start show as one attempt under way; the
// control refuses to pile up either.
let manualInFlight = false;
let startInFlight = false;

function syncAttempting() {
  const inFlight = manualInFlight || startInFlight;
  connectionStateElement.classList.toggle("is-attempting", inFlight);
  if (inFlight) connectionStateElement.setAttribute("aria-busy", "true");
  else connectionStateElement.removeAttribute("aria-busy");
}

onManualRecovery(inFlight => {
  manualInFlight = inFlight;
  syncAttempting();
});

// Starts the current workspace's session through the hub. A 200 changes
// nothing here: the hub reopens the page's topics, the document state
// arrives, and the channel confirms — that is what turns the label back to
// `Connected`. The attempt is shown until then, or until the recovery
// window elapses, after which the indicator says whatever the channel does
// (the child did start, so the ordinary reconnect applies). A refusal is
// shown under the indicator; a locked-credential refusal has already
// navigated to the dashboard's unlock flow.
async function startStoppedSession(): Promise<void> {
  if (startInFlight) return;
  const workspaceId = workspaceIdFromBasePath(appBasePath());
  if (workspaceId === null) return;
  startInFlight = true;
  clearConnectionError();
  syncAttempting();
  try {
    const outcome = await startWorkspaceSession(workspaceId);
    if (outcome.ok) {
      await awaitConfirmedLive();
    } else if (!outcome.unlock) {
      showConnectionError(outcome.message);
    }
  } finally {
    startInFlight = false;
    syncAttempting();
  }
}

// The hub's word on the current session (published by the workspace
// switcher). Only an explicit "not running" is a stopped session; unknown
// (a page with no hub) never shows `Stopped`.
onCurrentSessionRunning(running => {
  sessionStopped = running === false;
  syncConnectionDisplay();
});

// The markup ships the pre-connection state; this states it in the same place
// every later status does, so the control's ARIA is never a step behind the
// template.
syncConnectionDisplay();

// The one translation from live-channel transport status to indicator state.
// It lives here rather than at the call site so the indicator's contract —
// `Connected` only after authoritative state was applied, `Reconnecting` for
// the whole gap — is testable without dragging in the SSE reducer's DOM
// dependencies.
export function applyChannelStatus(status: LiveChannelStatus) {
  if (status === "live") setConnectionState("live", "Online");
  else if (status === "reconnecting") setConnectionState("reconnecting", "Reconnecting");
  else setConnectionState("connecting", "Connecting");
}

export function renderBuildBadge(build: BuildSummary) {
  buildBadgeElement.textContent = build.identifier;
  buildBadgeElement.title = build.release
    ? `Release build · ${build.commitSha}`
    : `Dev build on ${build.branch} · ${build.commitSha}`;
}
