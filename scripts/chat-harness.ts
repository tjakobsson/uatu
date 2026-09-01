/**
 * Scripted-agent chat harness (task 3.5 of add-claude-code-agent): serves
 * the real UatuCode SPA against the e2e fake agents so every chat surface —
 * agent choice, chooser attribution, header follow, and each later Claude
 * surface — can be exercised and reviewed in a browser without a real agent.
 *
 * Run: bun run scripts/chat-harness.ts [--agents 2] [--port 4173]
 *
 * Prints the ready-to-open URL (workspace token included) and seeds a
 * conversation per offered agent so the chooser starts populated. The
 * `/__e2e/chat` control endpoint stays available for scripting scenarios
 * (permissions, questions, task progress, ...) against the live page.
 */
const args = process.argv.slice(2);
const readFlag = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const port = readFlag("port", "4173");
const agents = Number.parseInt(readFlag("agents", "2"), 10) === 1 ? 1 : 2;

process.env.UATU_E2E_PORT = port;
// Present real agent names in the review harness (e2e keeps the fixture default).
process.env.UATU_E2E_PRIMARY_AGENT_NAME = "OpenCode";

// The harness server binds on import.
await import("../tests/e2e/server");

const origin = `http://127.0.0.1:${port}`;
const control = async (body: Record<string, unknown>): Promise<unknown> => {
  const response = await fetch(`${origin}/__e2e/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`harness control failed: ${response.status}`);
  return response.json();
};

await fetch(`${origin}/__e2e/reset`, { method: "POST" });
await control({ action: "agents", count: agents });
await control({ action: "seed", title: "OpenCode fixture conversation", items: [
  { id: "message:seed-oc", type: "user_message", createdAt: 1, text: "Show me the OpenCode side." },
  { id: "part:seed-oc", type: "assistant_message", createdAt: 2, markdown: "This conversation belongs to the **OpenCode** fixture agent." },
] });
if (agents === 2) {
  await control({ action: "seed", agent: "claude", title: "Claude Code fixture conversation", items: [
    { id: "message:seed-cc", type: "user_message", createdAt: 3, text: "And the Claude Code side?" },
    { id: "part:seed-cc", type: "assistant_message", createdAt: 4, markdown: "This one belongs to the **Claude Code** fixture agent — watch the header follow the selection." },
  ] });
}

const token = await fetch(`${origin}/__e2e/terminal-token`).then(response => response.json()) as { token: string };
console.log("");
console.log(`chat harness ready (${agents} agent${agents === 1 ? "" : "s"}):`);
console.log(`  ${origin}/?t=${encodeURIComponent(token.token)}`);
console.log("");
console.log("open Chat in the side panel; the control endpoint is POST /__e2e/chat");
