// Connection-status chip and build badge — the small status surface in the
// top-right of the shell. Extracted from `app.ts` so the shell's event /
// boot modules can call into the same DOM refs without re-querying.
//
// The module queries its DOM dependencies once at module-load (mirroring the
// pattern in `app.ts`) and throws if they aren't present. This is a hard
// contract: the shell relies on these elements existing in index.html, and a
// missing one is a build / template bug we want to surface loudly, not
// degrade silently.

import type { BuildSummary } from "../shared/types";
import type { LiveChannelStatus } from "./live-channel";
import { onManualRecovery, requestManualRecovery } from "./live";

const connectionStateElementMaybe = document.querySelector<HTMLElement>("#connection-state");
const connectionLabelElementMaybe = connectionStateElementMaybe?.querySelector<HTMLElement>(".connection-label") ?? null;
const buildBadgeElementMaybe = document.querySelector<HTMLElement>("#build-badge");

if (!connectionStateElementMaybe || !connectionLabelElementMaybe || !buildBadgeElementMaybe) {
  throw new Error("uatu UI failed to initialize (connection)");
}

// Locally-scoped non-null aliases. TypeScript's narrowing from the
// throw-if-null guard above doesn't survive into function bodies (the
// hoisted function declarations sit outside the if-block's control-flow
// scope), so we re-alias to `T` here.
const connectionStateElement: HTMLElement = connectionStateElementMaybe;
const connectionLabelElement: HTMLElement = connectionLabelElementMaybe;
const buildBadgeElement: HTMLElement = buildBadgeElementMaybe;

export type ConnectionRawState = "live" | "reconnecting" | "connecting";

let connectionRawState: ConnectionRawState = "connecting";

export function setConnectionState(state: ConnectionRawState, _label: string) {
  // The label argument is preserved for source-call clarity but the actual
  // display text is derived in syncConnectionDisplay.
  connectionRawState = state;
  syncConnectionDisplay();
}

function syncConnectionDisplay() {
  connectionStateElement.classList.remove("is-live", "is-reconnecting", "is-connecting");
  connectionStateElement.classList.add(`is-${connectionRawState}`);
  let label: string;
  let title: string;
  if (connectionRawState === "reconnecting") {
    label = "Reconnecting";
    title = "Reconnecting to the uatu backend";
  } else if (connectionRawState === "connecting") {
    label = "Connecting";
    title = "Connecting to the uatu backend";
  } else {
    label = "Connected";
    title = "Connected to the uatu backend";
  }
  connectionLabelElement.textContent = label;
  connectionStateElement.title = title;
  // The title keeps naming the state — it is what a mouse user hovers for,
  // and it is the string the e2e locators read. The accessible name names
  // the ACTION instead, because that is what activating the control does;
  // only while live, when the control is inert, do the two agree.
  const live = connectionRawState === "live";
  connectionStateElement.setAttribute("aria-label", live ? title : "Reconnect to the uatu backend");
  // `aria-disabled`, not `disabled`: a disabled button leaves the tab order
  // and stops showing its tooltip, and the state is still worth reading
  // while the connection is healthy.
  connectionStateElement.setAttribute("aria-disabled", live ? "true" : "false");
}

// The shell's half of the manual recovery. The Chat surface offers the same
// action on its interruption line; both call the one `requestManualRecovery`,
// which joins an attempt already in flight rather than starting a second.
connectionStateElement.addEventListener("click", () => {
  if (connectionRawState === "live") return;
  void requestManualRecovery();
});

onManualRecovery(inFlight => {
  connectionStateElement.classList.toggle("is-attempting", inFlight);
  if (inFlight) connectionStateElement.setAttribute("aria-busy", "true");
  else connectionStateElement.removeAttribute("aria-busy");
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
