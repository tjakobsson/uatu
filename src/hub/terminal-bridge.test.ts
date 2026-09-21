// The terminal WebSocket bridge's teardown, in two layers. First against a
// scripted child that can refuse, stall, or take over, with a fake browser
// socket — the event orders a real browser produces but a test cannot
// schedule. Then against a REAL terminal child (the child's own route
// table over an in-process PTY server) behind an in-process hub, driven by
// real WebSocket clients, so the application close codes and the
// detach-not-kill contract are shown to survive the bridge end to end.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";

import { buildFetchFallback } from "../server/routes";
import { terminalBackendAvailable } from "../terminal/backend";
import { createTerminalServer, type TerminalServer } from "../terminal/server";
import type { RunningSession } from "./backend";
import {
  WebSocketBridge,
  bridgeWebSocketHandlers,
  proxyHttp,
  upgradeToBridge,
  type BridgeData,
} from "./proxy";

const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
};

function sessionFor(port: number): RunningSession {
  return {
    workspaceId: "project",
    basePath: "/s/project/",
    endpoint: { hostname: "127.0.0.1", port },
    token: "child-secret",
    exited: new Promise(() => undefined),
    async stop() {},
  };
}

// A child whose behaviour the URL selects: `mode=refuse` answers 409 to the
// upgrade, `mode=slow` upgrades after a pause, `mode=takeover` closes the
// socket with 4410 once open. Everything it sees is recorded.
function scriptedChild() {
  const log: { event: string; data?: string; code?: number; reason?: string }[] = [];
  const server = Bun.serve<{ mode: string }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, srv) {
      const url = new URL(request.url);
      const mode = url.searchParams.get("mode") ?? "open";
      log.push({ event: "upgrade-request", data: mode });
      if (mode === "refuse") return new Response("sessionId in use", { status: 409 });
      if (mode === "slow") await Bun.sleep(120);
      if (srv.upgrade(request, { data: { mode } })) return undefined;
      return new Response("upgrade failed", { status: 500 });
    },
    websocket: {
      open(socket) {
        log.push({ event: "open" });
        if (socket.data.mode === "takeover") socket.close(4410, "session taken");
      },
      message(_socket, data) {
        log.push({ event: "message", data: typeof data === "string" ? data : `<${data.byteLength} bytes>` });
      },
      close(_socket, code, reason) {
        log.push({ event: "close", code, reason });
      },
    },
  });
  return { server, log, session: sessionFor(server.port!) };
}

// The browser side as the bridge sees it: a Bun server socket it can send to
// and close. What it was closed with is what the browser would have seen.
function fakeBrowser() {
  const closes: { code?: number; reason?: string }[] = [];
  const sent: unknown[] = [];
  const socket = {
    send(data: unknown) { sent.push(data); return 1; },
    close(code?: number, reason?: string) { closes.push({ code, reason }); },
  } as unknown as ServerWebSocket<BridgeData>;
  return { socket, closes, sent };
}

describe("WebSocketBridge teardown", () => {
  test("a browser that departs while the child is still opening leaves no holder and flushes nothing", async () => {
    const child = scriptedChild();
    try {
      const bridge = new WebSocketBridge(child.session, new URL("http://hub.example/s/project/api/terminal?sessionId=x&mode=slow"));
      const browser = fakeBrowser();
      bridge.attachBrowser(browser.socket);
      bridge.browserMessage(JSON.stringify({ type: "attach-ready", cols: 80, rows: 24 }));
      bridge.browserClosed(1001, "going away");
      expect(bridge.isClosed).toBe(true);
      // Two outcomes are correct, and which one depends on the runtime:
      // the connection is torn down before the child's upgrade completes
      // (the child never sees a socket), or the child does complete it and
      // the late `open` is answered with a close. Either way the queued
      // attach-ready never reaches the child and no socket stays open.
      await Bun.sleep(300);
      expect(child.log.filter(entry => entry.event === "message")).toEqual([]);
      const opens = child.log.filter(entry => entry.event === "open").length;
      const closes = child.log.filter(entry => entry.event === "close");
      expect(closes).toHaveLength(opens);
      for (const close of closes) expect(close.code).toBe(1001);
    } finally {
      await child.server.stop(true);
    }
  });

  test("a failed browser upgrade releases the child connection it had started", async () => {
    const child = scriptedChild();
    try {
      const response = upgradeToBridge(
        new Request("http://hub.example/s/project/api/terminal?sessionId=x", { headers: { upgrade: "websocket" } }),
        { upgrade: () => false },
        child.session,
      );
      expect(response?.status).toBe(500);
      // As above: either the child never sees the socket, or it sees one
      // that is closed straight away. Nothing is left open.
      await Bun.sleep(150);
      expect(child.log.filter(entry => entry.event === "message")).toEqual([]);
      const opens = child.log.filter(entry => entry.event === "open").length;
      const closes = child.log.filter(entry => entry.event === "close");
      expect(closes).toHaveLength(opens);
      for (const close of closes) expect(close.code).toBe(1001);
    } finally {
      await child.server.stop(true);
    }
  });

  test("a child that refuses before the browser attaches closes the browser with the refusal, not silence", async () => {
    const child = scriptedChild();
    try {
      const bridge = new WebSocketBridge(child.session, new URL("http://hub.example/s/project/api/terminal?sessionId=x&mode=refuse"));
      await waitFor(() => bridge.isClosed);
      const browser = fakeBrowser();
      bridge.attachBrowser(browser.socket);
      expect(browser.closes).toHaveLength(1);
      expect(browser.closes[0]!.code).toBe(1011);
      // Nothing the browser sends afterwards goes anywhere, and a second
      // departure is a no-op.
      bridge.browserMessage("late input");
      bridge.browserClosed(1000, "bye");
      expect(child.log.filter(entry => entry.event === "message")).toEqual([]);
    } finally {
      await child.server.stop(true);
    }
  });

  test("a child refusal after the browser attached closes the browser once, whatever arrives later", async () => {
    const child = scriptedChild();
    try {
      const bridge = new WebSocketBridge(child.session, new URL("http://hub.example/s/project/api/terminal?sessionId=x&mode=refuse"));
      const browser = fakeBrowser();
      bridge.attachBrowser(browser.socket);
      await waitFor(() => browser.closes.length > 0);
      expect(browser.closes).toEqual([{ code: 1011, reason: "upstream error" }]);
      await Bun.sleep(30);
      // The child's own close event follows its error; the browser is not
      // closed a second time with a different code.
      expect(browser.closes).toHaveLength(1);
    } finally {
      await child.server.stop(true);
    }
  });

  test("application close codes cross the bridge in both directions", async () => {
    const child = scriptedChild();
    try {
      // Browser → child: the confirmed pane close's termination code.
      const bridge = new WebSocketBridge(child.session, new URL("http://hub.example/s/project/api/terminal?sessionId=x"));
      const browser = fakeBrowser();
      bridge.attachBrowser(browser.socket);
      await waitFor(() => child.log.some(entry => entry.event === "open"));
      bridge.browserMessage("hello");
      await waitFor(() => child.log.some(entry => entry.event === "message"));
      bridge.browserClosed(4001, "user-close");
      await waitFor(() => child.log.some(entry => entry.event === "close"));
      expect(child.log.find(entry => entry.event === "close")).toEqual({ event: "close", code: 4001, reason: "user-close" });

      // Child → browser: the takeover notice.
      const taken = new WebSocketBridge(child.session, new URL("http://hub.example/s/project/api/terminal?sessionId=y&mode=takeover"));
      const displaced = fakeBrowser();
      taken.attachBrowser(displaced.socket);
      await waitFor(() => displaced.closes.length > 0);
      expect(displaced.closes).toEqual([{ code: 4410, reason: "session taken" }]);
    } finally {
      await child.server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Against a real terminal child.

type Frame = { kind: "text"; text: string } | { kind: "binary"; bytes: number };

// A browser as a real WebSocket client against the in-process hub, recording
// what it received and how it was closed.
function browserClient(hubPort: number, sessionId: string, options: { takeover?: boolean } = {}) {
  const frames: Frame[] = [];
  let closed: { code: number; reason: string } | null = null;
  let opened = false;
  const url = `ws://127.0.0.1:${hubPort}/s/project/api/terminal?sessionId=${sessionId}${options.takeover ? "&takeover=1" : ""}`;
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => { opened = true; });
  socket.addEventListener("message", event => {
    if (typeof event.data === "string") frames.push({ kind: "text", text: event.data });
    else frames.push({ kind: "binary", bytes: (event.data as ArrayBuffer).byteLength });
  });
  socket.addEventListener("close", event => { closed = { code: event.code, reason: event.reason }; });
  return {
    socket,
    frames,
    opened: () => opened,
    closed: () => closed,
    async open() { await waitFor(() => opened || closed !== null); },
    // Sends attach-ready and waits for the reconstruction frame — the
    // moment the child accepted this socket as the PTY's holder.
    async attach() {
      await this.open();
      socket.send(JSON.stringify({ type: "attach-ready", cols: 80, rows: 24 }));
      await waitFor(() => frames.some(frame => frame.kind === "binary") || closed !== null);
      return frames.some(frame => frame.kind === "binary");
    },
    close(code: number, reason: string) { socket.close(code, reason); },
  };
}

describe("terminal bridge against a real child", () => {
  let available = false;
  let terminalServer: TerminalServer | null = null;
  let child: Server<unknown> | null = null;
  let hub: Server<BridgeData> | null = null;
  let session: RunningSession;

  beforeAll(async () => {
    available = await terminalBackendAvailable();
    if (!available) return;
    terminalServer = createTerminalServer({ cwd: process.cwd() });
    const fetchFallback = buildFetchFallback({
      getTerminalServer: () => terminalServer,
      getTerminalToken: () => "child-secret",
      navigationFetch: async () => new Response("not found", { status: 404 }),
      basePath: "/s/project/",
    });
    child = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request, srv) => (await fetchFallback(request, srv)) ?? new Response("not found", { status: 404 }),
      websocket: {
        open: socket => { void terminalServer!.open(socket as never); },
        message: (socket, message) => { terminalServer!.message(socket as never, message as never); },
        close: (socket, code) => { terminalServer!.close(socket as never, code); },
      },
    });
    session = sessionFor(child.port!);
    hub = Bun.serve<BridgeData>({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request, srv) {
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          return upgradeToBridge(request, srv, session);
        }
        return await proxyHttp(request, session);
      },
      websocket: bridgeWebSocketHandlers,
    });
  });

  afterAll(async () => {
    terminalServer?.disposeAll();
    await hub?.stop(true);
    await child?.stop(true);
  });

  const hubOrigin = () => `http://127.0.0.1:${hub!.port}`;

  async function createPty(): Promise<string> {
    const response = await fetch(`${hubOrigin()}/s/project/api/terminal/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: hubOrigin() },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  async function inventory(): Promise<{ id: string; attached: boolean }[]> {
    const response = await fetch(`${hubOrigin()}/s/project/api/terminal/sessions`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { sessions: { id: string; attached: boolean }[] }).sessions;
  }

  const entry = async (id: string) => (await inventory()).find(candidate => candidate.id === id);

  test("ordinary departure detaches the PTY without killing it; explicit termination kills it", async () => {
    if (!available) return;
    const id = await createPty();
    const first = browserClient(hub!.port!, id);
    expect(await first.attach()).toBe(true);
    expect((await entry(id))?.attached).toBe(true);

    // Navigation away: the page's release is a plain 1000 close.
    first.close(1000, "page hidden");
    await waitFor(() => first.closed() !== null);
    let detached = await entry(id);
    for (let attempt = 0; attempt < 100 && detached?.attached !== false; attempt += 1) {
      await Bun.sleep(10);
      detached = await entry(id);
    }
    expect(detached).toEqual(expect.objectContaining({ id, attached: false }));

    // The same PTY reattaches to a later ordinary attach.
    const second = browserClient(hub!.port!, id);
    expect(await second.attach()).toBe(true);
    expect((await entry(id))?.attached).toBe(true);

    // The confirmed close's 4001 transits the bridge: the PTY is gone.
    second.close(4001, "user-close");
    await waitFor(() => second.closed() !== null);
    let gone = await entry(id);
    for (let attempt = 0; attempt < 100 && gone !== undefined; attempt += 1) {
      await Bun.sleep(10);
      gone = await entry(id);
    }
    expect(gone).toBeUndefined();
  });

  test("a refused attach preserves the holder: the newcomer's socket opens through the hub and then closes, the holder is untouched", async () => {
    if (!available) return;
    const id = await createPty();
    const holder = browserClient(hub!.port!, id);
    expect(await holder.attach()).toBe(true);

    const newcomer = browserClient(hub!.port!, id);
    await waitFor(() => newcomer.closed() !== null);
    // The browser side DID open — the hub accepted it before asking the
    // child — which is exactly why readiness, not open, marks attachment.
    expect(newcomer.opened()).toBe(true);
    expect(newcomer.frames).toEqual([]);
    expect(newcomer.closed()!.code).toBe(1011);
    expect(holder.closed()).toBeNull();
    expect((await entry(id))?.attached).toBe(true);
    holder.close(4001, "user-close");
  });

  test("a delayed departure is a collision for the replacement, and an ordinary attach succeeds once the child has processed it", async () => {
    if (!available) return;
    const id = await createPty();
    const departing = browserClient(hub!.port!, id);
    expect(await departing.attach()).toBe(true);

    // The departure and the replacement's attach race exactly as a
    // navigation makes them: close, then immediately connect again.
    departing.close(1000, "page hidden");
    let replacement = browserClient(hub!.port!, id);
    let attached = await replacement.attach();
    let collisions = 0;
    // The recovery loop's behaviour, spelled out: a refused attach is
    // reconciled through inventory and retried once the PTY reads detached.
    while (!attached) {
      collisions += 1;
      expect(replacement.closed()!.code).toBe(1011);
      let state = await entry(id);
      for (let attempt = 0; attempt < 200 && state?.attached !== false; attempt += 1) {
        await Bun.sleep(10);
        state = await entry(id);
      }
      expect(state?.attached).toBe(false);
      replacement = browserClient(hub!.port!, id);
      attached = await replacement.attach();
      if (collisions > 5) break;
    }
    expect(attached).toBe(true);
    expect((await entry(id))?.attached).toBe(true);
    replacement.close(4001, "user-close");
  });

  test("collision and takeover keep their application close codes through the bridge", async () => {
    if (!available) return;
    const id = await createPty();
    // Two sockets open before either attaches: the second attach-ready is
    // the in-open race the child answers with 4409.
    const winner = browserClient(hub!.port!, id);
    const loser = browserClient(hub!.port!, id);
    await winner.open();
    await loser.open();
    expect(await winner.attach()).toBe(true);
    expect(await loser.attach()).toBe(false);
    expect(loser.closed()!.code).toBe(4409);
    expect(winner.closed()).toBeNull();

    // An explicit takeover displaces the holder with 4410 and becomes the
    // holder itself.
    const claimant = browserClient(hub!.port!, id, { takeover: true });
    expect(await claimant.attach()).toBe(true);
    await waitFor(() => winner.closed() !== null);
    expect(winner.closed()!.code).toBe(4410);
    expect((await entry(id))?.attached).toBe(true);
    claimant.close(4001, "user-close");
  });
});
