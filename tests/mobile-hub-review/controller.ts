import type { createSyntheticBackend, Scenario } from "./backend";

export const scenarios = ["mixed", "empty", "signed-out", "branches", "credentials", "nested", "unavailable-tools", "all-running", "all-stopped"] as const satisfies readonly Scenario[];
// Deliberately excludes backend, inspect, snapshot and reset. Never dispatch an
// arbitrary property from request input. Backend controls validate domain enums.
export const controls = {
  hold: ["readCredentials"], settle: ["readCredentials", false], fail: ["readCredentials", null],
  setKeyState: ["ssh-locked", "locked"], setCredentialAvailable: ["ssh-locked", true],
  setCredentialFactsUnknown: ["ssh-locked", true], setOpenPgpUserId: ["pgp-locked", null],
  setToolConfigurationUnknown: ["git", true], expireCloneAttempt: ["review-attempt-1"],
  setDeviceInventory: ["multiple"], setToolState: ["git", "missing"],
  setStopFailure: ["atlas", true], setUnlockFailure: [true], setImportFailure: [true],
  setOnboardingFault: [null], setFolderFault: [null], setFolderAvailable: ["/synthetic", true],
  setCloneCleanupFailure: [true], clonePhase: ["review-job-1", "registering"],
  cloneOutput: ["review-job-1", "prompt"], finishClone: ["review-job-1", "succeeded"],
  disconnectClone: ["review-job-1"], expireClone: ["review-job-1"],
  invalidateAuthentication: [], advance: [1000],
} satisfies { [K in Exclude<keyof ReturnType<typeof createSyntheticBackend>, "backend" | "workspaceAvailable" | "snapshot" | "inspect" | "reset">]: Parameters<ReturnType<typeof createSyntheticBackend>[K]> };
export type ReviewControl = keyof typeof controls;
export type ReviewControlArguments<K extends ReviewControl> = Parameters<ReturnType<typeof createSyntheticBackend>[K]>;

export function dispatchControl(backend: ReturnType<typeof createSyntheticBackend>, name: string, args: unknown): unknown {
  if (!Object.hasOwn(controls, name) || !Array.isArray(args)) throw new Error("Unknown control");
  const example = controls[name as ReviewControl];
  if (args.length !== example.length) throw new Error("Control arity");
  for (let i = 0; i < example.length; i++) {
    if (example[i] !== null && typeof args[i] !== typeof example[i]) throw new Error("Control argument type");
  }
  if (name === "advance" && (!Number.isSafeInteger(args[0]) || args[0] < 0)) throw new Error("Invalid clock");
  const operation = backend[name as ReviewControl] as (...args: never[]) => unknown;
  return operation(...args as never[]);
}

export const controller = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Mock Hub controller</title>
<h1>Mock backend; do not enter real credentials</h1><p>Independent synthetic state. No shells, providers, Git or filesystem operations. Not live-backend validation.</p>
<p>Simulation login: reviewer / review-only. Controls are outside the product viewport.</p><a href="/" target="_blank" rel="noopener">Open mobile Hub frontend</a>
<form id="reset"><label>Scenario <select name="scenario">${scenarios.map(s => `<option>${s}</option>`).join("")}</select></label><button>Reset synthetic state</button></form>
<form id="control"><label>Control <select name="control">${Object.keys(controls).map(s => `<option>${s}</option>`).join("")}</select></label><label>Arguments (JSON array; synthetic data only) <input name="args" size="70"></label><button>Apply control</button></form>
<p>Clone stream controls use the accepted job id; attempt expiry uses the original attempt id. Pending/expired/unavailable never authorize blind submission. Explicit facts and saved overrides are shown in public state, never inferred from diagnostic text. <a href="/review/capabilities">Review capabilities</a>. No arbitrary output injection is supported.</p>
<p>${["upload-hold", "upload-settle", "upload-fail", "chat-output", "terminal-output"].map(name => `<button data-protocol="${name}">${name}</button>`).join(" ")} <button id="refresh">Refresh public state</button></p>
<pre id="error" role="status"></pre><pre id="state"></pre><script src="/review/controller.js"></script><script>document.querySelectorAll('[data-protocol]').forEach(button=>button.onclick=()=>post('/review/control/'+button.dataset.protocol,[]));document.querySelector('#refresh').onclick=refresh;</script></html>`;
export const controllerScript = `const examples=${JSON.stringify(controls)};const form=document.querySelector('#control');const state=document.querySelector('#state');async function refresh(){state.textContent=JSON.stringify(await(await fetch('/review/state')).json(),null,2)}function preset(){form.elements.args.value=JSON.stringify(examples[form.elements.control.value])}form.elements.control.onchange=preset;preset();async function post(path,body){const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});document.querySelector('#error').textContent=response.ok?'Synthetic control applied':'Synthetic control rejected';await refresh()}document.querySelector('#reset').onsubmit=async e=>{e.preventDefault();await post('/review/reset',{scenario:new FormData(e.target).get('scenario')})};form.onsubmit=async e=>{e.preventDefault();try{await post('/review/control/'+form.elements.control.value,JSON.parse(form.elements.args.value))}catch{document.querySelector('#error').textContent='Invalid synthetic arguments'}};refresh();`;
