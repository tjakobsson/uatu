import type { TerminalSessionInfo } from "../../src/terminal/server";

/** Inventory only: no PTY, command execution, terminal input or secrets. */
export function createTerminalProtocolModel(initialId: string, createdAt: number) {
  const sessions = new Map<string, TerminalSessionInfo>();
  const reset = () => { sessions.clear(); sessions.set(initialId, { id: initialId, label: "Synthetic terminal", attached: false, createdAt, cols: 80, rows: 24 }); };
  reset();
  return {
    reset,
    has: (id: string) => sessions.has(id),
    remove: (id: string) => sessions.delete(id),
    attached(id: string, attached: boolean) { const row = sessions.get(id); if (row) row.attached = attached; },
    async handle(request: Request, url: URL): Promise<Response | null> {
      const match = /^\/api\/terminal\/sessions(?:\/([a-f0-9-]+))?$/.exec(url.pathname);
      if (!match) return null;
      if (!match[1] && request.method === "GET") return Response.json({ sessions: [...sessions.values()] });
      if (!match[1] && request.method === "POST") {
        if (sessions.size >= 8) return Response.json({ error: "Synthetic terminal limit (8)" }, { status: 409 });
        const session: TerminalSessionInfo = { id: crypto.randomUUID(), label: `Synthetic terminal ${sessions.size + 1}`, attached: false, createdAt, cols: 80, rows: 24 };
        sessions.set(session.id, session); return Response.json(session, { status: 201 });
      }
      if (match[1] && request.method === "DELETE") return sessions.delete(match[1]) ? new Response(null, { status: 204 }) : Response.json({ error: "Unknown synthetic terminal session" }, { status: 404 });
      return Response.json({ error: "Unsupported synthetic terminal inventory action" }, { status: 405 });
    },
  };
}
