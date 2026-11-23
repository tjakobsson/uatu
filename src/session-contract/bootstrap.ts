// Session contract: the policy bootstrap over descriptor 3 and the readiness
// proof that follows it. The Hub hands a starting workspace session a
// private socket; the session writes a readiness marker, the Hub answers
// with the policy binding and secret, and once the session is serving the
// Hub challenges it to prove it holds that secret. Only then is policy trust
// ready. A session that skips any step still runs, without policy trust.
import { randomBytes } from "node:crypto";
import { connect, type Socket, type NetConnectOpts } from "node:net";
import { SESSION_POLICY_PROOF_PATH, sessionPath } from "./paths";
import { POLICY_ENVELOPE_MAX_BYTES, readChildPolicyBootstrap, type PolicyAuthority } from "./policy";

const READY = "uatu-hub-private-bootstrap-v1\n";

// Do not send a secret to an old/non-consuming child: first require a
// non-secret readiness marker on the private descriptor itself.
export function sendChildPolicyDescriptor(fd: number, payload: () => string, timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    let socket: Socket;
    try { socket = connect({ fd } as unknown as NetConnectOpts); } catch { resolve(false); return; }
    let settled = false, marker = "";
    const finish = (sent: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(sent);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
    socket.once("finish", () => finish(true));
    socket.on("data", chunk => {
      marker += chunk.toString("utf8");
      if (marker.length > READY.length || !READY.startsWith(marker)) { finish(false); return; }
      if (marker === READY) {
        try { socket.end(payload() + "\n"); } catch { finish(false); }
      }
    });
  });
}

// Called only by the internal Hub-spawn marker, before runtime/tool setup.
// Never log bootstrap bytes or propagate the descriptor to a descendant.
export function consumeChildPolicyDescriptor(fd = 3, timeoutMs = 2000): Promise<ReturnType<typeof readChildPolicyBootstrap> | null> {
  return new Promise(resolve => {
    let socket: Socket;
    // Bun's documented socket-fd handoff uses connect({fd}); constructing a
    // Socket({fd}) alone does not register reads in the current runtime.
    try { socket = connect({ fd } as unknown as NetConnectOpts); } catch { resolve(null); return; }
    let text = "";
    let settled = false;
    const finish = (policy: ReturnType<typeof readChildPolicyBootstrap> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(policy);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("error", () => finish(null));
    socket.on("end", () => finish(null));
    socket.on("close", () => finish(null));
    socket.write(READY);
    socket.on("data", chunk => {
      text += chunk.toString("utf8");
      if (Buffer.byteLength(text) > POLICY_ENVELOPE_MAX_BYTES) { finish(null); return; }
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      try {
        const policy = readChildPolicyBootstrap(text.slice(0, newline));
        text = "";
        finish(policy);
      } catch { text = ""; finish(null); }
    });
    socket.resume();
  });
}

// Hub side, after the ready line: challenge the session to prove it consumed
// the bootstrap. True only for a valid proof within the timeout. A missing,
// old or invalid session never falls back to the session token as policy
// authority.
export async function verifyPolicyReadiness(origin: string, basePath: string, authority: PolicyAuthority, timeoutMs = 2000): Promise<boolean> {
  const challenge = randomBytes(32).toString("base64url");
  try {
    const response = await fetch(new URL(sessionPath(basePath, SESSION_POLICY_PROOF_PATH), origin), {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ challenge }), signal: AbortSignal.timeout(timeoutMs),
    });
    const proof = response.ok ? await response.json() as { proof?: unknown } : null;
    return typeof proof?.proof === "string" && authority.verifyProof(challenge, proof.proof);
  } catch { return false; }
}
