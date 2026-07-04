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
}

export function renderBuildBadge(build: BuildSummary) {
  buildBadgeElement.textContent = build.identifier;
  buildBadgeElement.title = build.release
    ? `Release build · ${build.commitSha}`
    : `Dev build on ${build.branch} · ${build.commitSha}`;
}
