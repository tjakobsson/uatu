#!/usr/bin/env bun
// A fake `agy` for tests: `agy --version` prints the fixture's version, and
// `agy acp` is an ACP v1 agent on stdio built with the official SDK's agent
// side, answering from the redacted trial fixture (agy-fixture.json). It never
// touches the network and has no login of its own.
//
// Everything it keeps lives in $AGY_FAKE_STATE, so a listing process and a
// conversation's process see the same sessions:
//   sessions.json        the sessions, their configuration and replay
//   log.jsonl            every request and notification it received, plus
//                        the outcome of each permission request it made
//   auth-missing         present: every session call fails with -32000
//   crash-on-prompt      present: the process exits 1 on the next prompt
//   no-image             present: initialize advertises no image prompts
//   pids                 the pid of every `agy acp` process started
//   refuse-steer         present: a prompt sent during a run is refused (-32603)
//   crash-on-steer       present: the process exits 1 on a prompt sent during a run
//   hang-initialize      present: `initialize` never answers
//   slow-config          present: `session/set_config_option` answers after 300 ms
//   fail-load            present: `session/load` fails after sending its replay
//   legacy-only          present: no config options; models are chosen by legacy
//                        id through `session/set_model`
//   no-legacy-models     present: session answers carry no legacy model list
//   hang-list            present: `session/list` never answers
//   orphan-child         present: each process starts a `sleep 30` worker in its
//                        group, its pid in `orphans`
//
// A prompt whose first text starts with `<script>:` runs that fixture script;
// anything else runs `text`. A second prompt during a running script is
// taken into the run as agy does: the first prompt resolves `end_turn` and
// the second carries the run on.

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { agent, methods, ndJsonStream, RequestError, type AgentContext } from "@agentclientprotocol/sdk";

type Update = Record<string, unknown> & { sessionUpdate: string };
type Step =
  | { update: Update }
  | { permission: { toolCallId: string; title: string; kind: string } }
  | { waitForSteer: { usage?: Record<string, number> } }
  | { waitForCancel: { update?: Update } };
type Script = { title?: string; steps: Step[]; onReject?: Step[]; stopReason: string; usage?: Record<string, number> };
type Fixture = {
  version: string;
  initialize: Record<string, unknown> & { agentCapabilities: { promptCapabilities: Record<string, boolean> } };
  modes: { currentModeId: string; availableModes: Array<{ id: string; name: string; description: string }> };
  defaultModel: string;
  defaultThoughtLevel: string;
  models: Array<{ value: string; name: string; levels: string[] }>;
  levelNames: Record<string, string>;
  contextSize: number;
  commands: Array<{ name: string; description: string; input: null }>;
  scripts: Record<string, Script>;
};
type StoredSession = { sessionId: string; cwd: string; title: string | null; updatedAt: string; model: string; thoughtLevel: string; mode: string; replay: Update[] };

const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, "agy-fixture.json"), "utf8")) as Fixture;

if (process.argv[2] === "--version") {
  console.log(fixture.version);
  process.exit(0);
}
if (process.argv[2] !== "acp") {
  console.error("fake agy: only --version and acp are supported");
  process.exit(2);
}

const stateDir = process.env.AGY_FAKE_STATE;
if (!stateDir) {
  console.error("fake agy: AGY_FAKE_STATE is not set");
  process.exit(2);
}
const sessionsFile = path.join(stateDir, "sessions.json");
appendFileSync(path.join(stateDir, "pids"), `${process.pid}\n`);
const flag = (name: string) => existsSync(path.join(stateDir, name));
// A worker in agy's process group that outlives it if nobody reaps the group.
if (flag("orphan-child")) appendFileSync(path.join(stateDir, "orphans"), `${Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] }).pid}\n`);
const log = (entry: unknown) => appendFileSync(path.join(stateDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
const readSessions = (): StoredSession[] => existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, "utf8")) as StoredSession[] : [];
const writeSessions = (sessions: StoredSession[]) => {
  const temporary = `${sessionsFile}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(sessions, null, 2));
  renameSync(temporary, sessionsFile);
};
const updateSession = (sessionId: string, change: (session: StoredSession) => void) => {
  const sessions = readSessions();
  const session = sessions.find(candidate => candidate.sessionId === sessionId);
  if (!session) return;
  change(session);
  session.updatedAt = new Date().toISOString();
  writeSessions(sessions);
};
const requireLogin = () => {
  if (flag("auth-missing")) throw new RequestError(-32000, "Authentication required");
};

const levelsOf = (model: string) => fixture.models.find(candidate => candidate.value === model)?.levels ?? [];
function configOptions(session: { model: string; thoughtLevel: string; mode: string }) {
  const levels = levelsOf(session.model);
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: session.model, options: fixture.models.map(model => ({ value: model.value, name: model.name })) },
    ...(levels.length ? [{ id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: levels.includes(session.thoughtLevel) ? session.thoughtLevel : levels[0]!, options: levels.map(level => ({ value: level, name: fixture.levelNames[level] ?? level })) }] : []),
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: session.mode, options: fixture.modes.availableModes.map(mode => ({ value: mode.id, name: mode.name, description: mode.description })) },
  ];
}
function legacyModels(session: { model: string; thoughtLevel: string }) {
  const availableModels = fixture.models.flatMap(model => model.levels.length
    ? model.levels.map(level => ({ modelId: `${model.value}-${level}`, name: `${model.name} (${fixture.levelNames[level] ?? level})` }))
    : [{ modelId: model.value, name: model.name }]);
  const levels = levelsOf(session.model);
  return { currentModelId: levels.length ? `${session.model}-${session.thoughtLevel}` : session.model, availableModels };
}
const sessionAnswer = (session: StoredSession) => ({
  modes: { ...fixture.modes, currentModeId: session.mode },
  ...(flag("no-legacy-models") ? {} : { models: legacyModels(session) }),
  ...(flag("legacy-only") ? {} : { configOptions: configOptions(session) }),
});
const substitute = <T>(value: T, cwd: string): T => JSON.parse(JSON.stringify(value).replaceAll("{cwd}", cwd)) as T;

type PromptResult = { stopReason: string; usage?: Record<string, number> };
type Run = {
  resolve: (result: PromptResult) => void;
  cancelled: boolean;
  cancelWaiters: Array<() => void>;
  steerWaiters: Array<() => void>;
  pendingSteerUsage?: Record<string, number>;
};
const runs = new Map<string, Run>();
// Sessions this process loaded although agy's list does not know them: agy
// answers the load and fails the next prompt.
const broken = new Set<string>();

const app = agent({ name: "fake-agy" });

app.onNotification(methods.agent.session.cancel, ({ params }) => {
  log({ method: "session/cancel", params });
  const run = runs.get(params.sessionId);
  if (!run) return;
  run.cancelled = true;
  for (const waiter of run.cancelWaiters.splice(0)) waiter();
});

app.onRequest(methods.agent.initialize, async ({ params }) => {
  log({ method: "initialize", params });
  if (flag("hang-initialize")) await new Promise(() => undefined);
  const answer = structuredClone(fixture.initialize);
  if (flag("no-image")) answer.agentCapabilities.promptCapabilities.image = false;
  return answer as never;
});

app.onRequest(methods.agent.session.list, async ({ params }) => {
  log({ method: "session/list", params });
  if (flag("hang-list")) await new Promise(() => undefined);
  requireLogin();
  return { sessions: readSessions().filter(session => !params.cwd || session.cwd === params.cwd).map(session => ({ sessionId: session.sessionId, cwd: session.cwd, ...(session.title ? { title: session.title } : {}), updatedAt: session.updatedAt })) };
});

app.onRequest(methods.agent.session.new, async ({ params, client }) => {
  log({ method: "session/new", params });
  requireLogin();
  const session: StoredSession = { sessionId: crypto.randomUUID(), cwd: params.cwd, title: null, updatedAt: new Date().toISOString(), model: fixture.defaultModel, thoughtLevel: fixture.defaultThoughtLevel, mode: fixture.modes.currentModeId, replay: [] };
  writeSessions([...readSessions(), session]);
  setTimeout(() => void client.notify(methods.client.session.update, { sessionId: session.sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: fixture.commands } } as never), 0);
  return { sessionId: session.sessionId, ...sessionAnswer(session) } as never;
});

app.onRequest(methods.agent.session.load, async ({ params, client }) => {
  log({ method: "session/load", params });
  requireLogin();
  const session = readSessions().find(candidate => candidate.sessionId === params.sessionId);
  if (!session) {
    broken.add(params.sessionId);
    return { ...sessionAnswer({ sessionId: params.sessionId, cwd: params.cwd, title: null, updatedAt: "", model: fixture.defaultModel, thoughtLevel: fixture.defaultThoughtLevel, mode: fixture.modes.currentModeId, replay: [] }) } as never;
  }
  // A loaded session is back on agy's defaults, as the trial showed.
  updateSession(session.sessionId, stored => { stored.model = fixture.defaultModel; stored.thoughtLevel = fixture.defaultThoughtLevel; stored.mode = fixture.modes.currentModeId; });
  for (const update of session.replay) await client.notify(methods.client.session.update, { sessionId: session.sessionId, update } as never);
  if (flag("fail-load")) throw new RequestError(-32603, "Failed to load the conversation");
  setTimeout(() => void client.notify(methods.client.session.update, { sessionId: session.sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: fixture.commands } } as never), 0);
  return sessionAnswer({ ...session, model: fixture.defaultModel, thoughtLevel: fixture.defaultThoughtLevel, mode: fixture.modes.currentModeId }) as never;
});

app.onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
  log({ method: "session/set_config_option", params });
  if (flag("legacy-only")) throw RequestError.methodNotFound("session/set_config_option");
  if (flag("slow-config")) await Bun.sleep(300);
  let answer: ReturnType<typeof configOptions> = [];
  updateSession(params.sessionId, session => {
    const value = String(params.value);
    if (params.configId === "model") session.model = value;
    else if (params.configId === "thought_level") session.thoughtLevel = value;
    else if (params.configId === "mode") session.mode = value;
    answer = configOptions(session);
  });
  return { configOptions: answer } as never;
});

// agy's legacy model selection, outside the stable ACP methods.
app.onRequest("session/set_model", (value: unknown) => value as { sessionId: string; modelId: string }, ({ params }) => {
  log({ method: "session/set_model", params });
  const family = fixture.models.find(model => params.modelId === model.value || model.levels.some(level => params.modelId === `${model.value}-${level}`));
  if (!family) throw new RequestError(-32602, `unknown model ${params.modelId}`);
  updateSession(params.sessionId, session => {
    session.model = family.value;
    const level = params.modelId.slice(family.value.length + 1);
    if (level) session.thoughtLevel = level;
  });
  return {};
});

app.onRequest(methods.agent.session.setMode, ({ params }) => {
  log({ method: "session/set_mode", params });
  updateSession(params.sessionId, session => { session.mode = params.modeId; });
  return {};
});

app.onRequest(methods.agent.session.prompt, ({ params, client }) => {
  log({ method: "session/prompt", params });
  if (flag("crash-on-prompt")) process.exit(1);
  requireLogin();
  if (broken.has(params.sessionId)) throw new RequestError(-32603, `Failed to send user message: not_found: trajectory not found: ${params.sessionId}: not found`);
  const text = params.prompt.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
  const running = runs.get(params.sessionId);
  if (running && flag("refuse-steer")) throw new RequestError(-32603, "Antigravity is busy and did not take the message");
  if (running && flag("crash-on-steer")) process.exit(1);
  // Replay keeps the prompt's blocks: its text, then each image.
  updateSession(params.sessionId, session => {
    for (const block of params.prompt) {
      if (block.type === "text" && block.text) session.replay.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: block.text } });
      else if (block.type === "image") session.replay.push({ sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: block.mimeType, data: "" } });
    }
  });
  if (running) {
    // A steer: the earlier prompt ends now, and this one carries the run.
    return new Promise<PromptResult>(resolve => {
      const previous = running.resolve;
      running.resolve = resolve;
      previous({ stopReason: "end_turn", ...(running.pendingSteerUsage ? { usage: running.pendingSteerUsage } : {}) });
      for (const waiter of running.steerWaiters.splice(0)) waiter();
    }) as never;
  }
  const name = text.match(/^(\w+):/)?.[1];
  const script = fixture.scripts[name && fixture.scripts[name] ? name : "text"]!;
  return new Promise<PromptResult>(resolve => {
    const run: Run = { resolve, cancelled: false, cancelWaiters: [], steerWaiters: [] };
    runs.set(params.sessionId, run);
    void perform(params.sessionId, script, run, client).then(result => {
      runs.delete(params.sessionId);
      run.resolve(result);
    }, error => {
      runs.delete(params.sessionId);
      console.error(error);
      run.resolve({ stopReason: "end_turn" });
    });
  }) as never;
});

async function perform(sessionId: string, script: Script, run: Run, client: AgentContext): Promise<PromptResult> {
  const cwd = readSessions().find(session => session.sessionId === sessionId)?.cwd ?? "";
  const send = async (update: Update) => {
    const concrete = substitute(update, cwd);
    await client.notify(methods.client.session.update, { sessionId, update: concrete } as never);
    if (["agent_message_chunk", "agent_thought_chunk"].includes(concrete.sessionUpdate)) updateSession(sessionId, session => { session.replay.push(concrete); });
    // A tool call replays where it started, in its final state, so a steer
    // taken while it ran replays after it, where the live run showed it.
    if (concrete.sessionUpdate === "tool_call" || concrete.sessionUpdate === "tool_call_update") {
      updateSession(sessionId, session => {
        const index = session.replay.findIndex(entry => entry.sessionUpdate === "tool_call" && entry.toolCallId === concrete.toolCallId);
        const merged = { ...(index >= 0 ? session.replay[index] : {}), ...concrete, sessionUpdate: "tool_call" };
        if (index >= 0) session.replay[index] = merged;
        else session.replay.push(merged);
      });
    }
  };
  const cancelled = () => ({ stopReason: "cancelled", ...(script.usage ? { usage: script.usage } : {}) });
  const title = readSessions().find(session => session.sessionId === sessionId)?.title;
  if (!title) {
    const next = script.title ?? "Fixture conversation";
    updateSession(sessionId, session => { session.title = next; });
    await send({ sessionUpdate: "session_info_update", title: next });
  }
  let steps = script.steps;
  for (let index = 0; index < steps.length; index++) {
    if (run.cancelled) return cancelled();
    const step = steps[index]!;
    if ("update" in step) await send(step.update);
    else if ("permission" in step) {
      const answer = await client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: step.permission.toolCallId, title: step.permission.title, kind: step.permission.kind, status: "pending" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
      } as never) as { outcome: { outcome: string; optionId?: string } };
      log({ method: "permission-outcome", outcome: answer.outcome });
      if (answer.outcome.outcome === "cancelled" || run.cancelled) return cancelled();
      if (answer.outcome.optionId === "deny") { steps = [...steps.slice(0, index + 1), ...(script.onReject ?? [])]; continue; }
    } else if ("waitForSteer" in step) {
      run.pendingSteerUsage = step.waitForSteer.usage;
      await new Promise<void>(resolve => { run.steerWaiters.push(resolve); run.cancelWaiters.push(resolve); });
      run.pendingSteerUsage = undefined;
    } else if ("waitForCancel" in step) {
      await new Promise<void>(resolve => run.cancelWaiters.push(resolve));
      if (step.waitForCancel.update) await send(step.waitForCancel.update);
      return cancelled();
    }
  }
  return { stopReason: script.stopReason, ...(script.usage ? { usage: script.usage } : {}) };
}

const input = Bun.stdin.stream();
const output = new WritableStream<Uint8Array>({ write: chunk => { process.stdout.write(chunk); } });
const connection = app.connect(ndJsonStream(output, input));
// Closing stdin ends the connection; agy then exits 0.
void connection.closed.then(() => process.exit(0));
