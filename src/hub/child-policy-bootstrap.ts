import { connect, type Socket, type NetConnectOpts } from "node:net";
import { readChildPolicyBootstrap } from "./child-policy";

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
      if (Buffer.byteLength(text) > 8192) { finish(null); return; }
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
