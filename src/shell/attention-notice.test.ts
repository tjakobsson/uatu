import { expect, test } from "bun:test";
import { AttentionNotices, attentionNoticeHref, QUIET_BEFORE_NOTICE_MS } from "./attention-notice";
import type { WorkspaceActivity } from "../shared/live-protocol";

const quiet: WorkspaceActivity = { running: true, working: false, awaiting: false, finished: false };
const waiting: WorkspaceActivity = { running: true, working: true, awaiting: true, finished: false };
const finished: WorkspaceActivity = { running: true, working: false, awaiting: false, finished: true };
const stopped: WorkspaceActivity = { running: false, working: false, awaiting: false, finished: false };

// Each report comes a quiet period after the previous one unless a test says otherwise.
function fixture(currentId = "alpha") {
  const renders: string[][] = [];
  let now = 0;
  const notices = new AttentionNotices(currentId, shown => renders.push(shown.map(notice => notice.workspaceId)), () => now);
  const report = notices.report.bind(notices);
  notices.report = (ws, facts) => { now += QUIET_BEFORE_NOTICE_MS; report(ws, facts); };
  const ids = () => notices.notices().map(notice => notice.workspaceId);
  return { notices, renders, ids, report, advance: (ms: number) => { now += ms; } };
}

test("a question in another workspace raises a notice", () => {
  const { notices, ids } = fixture();
  notices.report("beta", quiet);
  notices.report("beta", waiting);
  expect(ids()).toEqual(["beta"]);
});

test("the workspace the page serves never notifies itself", () => {
  const { notices, ids, renders } = fixture();
  notices.report("alpha", quiet);
  notices.report("alpha", waiting);
  expect(ids()).toEqual([]);
  expect(renders).toEqual([]);
});

test("a workspace already waiting when the page loads is the baseline, not a notice", () => {
  const { notices, ids } = fixture();
  notices.report("beta", waiting);
  notices.report("beta", waiting);
  expect(ids()).toEqual([]);
  // Once it has stopped waiting, a new question is announced.
  notices.report("beta", quiet);
  notices.report("beta", waiting);
  expect(ids()).toEqual(["beta"]);
});

test("a question raised while the page was hidden is announced when the stream's snapshot arrives again", () => {
  const { notices, ids } = fixture();
  notices.report("beta", quiet);
  // Reconnect: the hub re-sends every workspace's current facts; nothing is reset on the page.
  notices.report("gamma", quiet);
  notices.report("beta", waiting);
  expect(ids()).toEqual(["beta"]);
});

test("the notice clears when the workspace stops waiting or stops running", () => {
  const { notices, ids } = fixture();
  notices.report("beta", quiet); notices.report("gamma", quiet);
  notices.report("beta", waiting); notices.report("gamma", waiting);
  notices.report("beta", quiet);
  expect(ids()).toEqual(["gamma"]);
  notices.report("gamma", stopped);
  expect(ids()).toEqual([]);
});

test("a finished turn elsewhere raises nothing", () => {
  const { notices, ids, renders } = fixture();
  notices.report("beta", quiet);
  notices.report("beta", { ...quiet, working: true });
  notices.report("beta", finished);
  expect(ids()).toEqual([]);
  expect(renders).toEqual([]);
});

test("several workspaces stack newest first, one notice each", () => {
  const { notices, ids } = fixture();
  for (const ws of ["beta", "gamma"]) notices.report(ws, quiet);
  notices.report("beta", waiting);
  notices.report("gamma", waiting);
  expect(ids()).toEqual(["gamma", "beta"]);
  // An unchanged report does not duplicate or reorder.
  notices.report("beta", waiting);
  expect(ids()).toEqual(["gamma", "beta"]);
});

test("dismissing keeps it gone until the workspace waits anew", () => {
  const { notices, ids } = fixture();
  notices.report("beta", quiet);
  notices.report("beta", waiting);
  notices.dismiss("beta");
  notices.report("beta", waiting);
  expect(ids()).toEqual([]);
  notices.report("beta", quiet);
  notices.report("beta", waiting);
  expect(ids()).toEqual(["beta"]);
});

test("a workspace that leaves the list takes its notice and its baseline with it", () => {
  const { notices, ids } = fixture();
  notices.report("beta", quiet);
  notices.report("beta", waiting);
  notices.forget("beta");
  expect(ids()).toEqual([]);
  notices.report("beta", waiting);
  expect(ids()).toEqual([]);
});

test("Open goes to the workspace and asks it for the waiting conversation", () => {
  expect(attentionNoticeHref("my project")).toBe("/s/my%20project/?awaiting=1");
});

test("the broker's momentary idle before it has read a workspace is not a new question", () => {
  const { report, ids, advance } = fixture();
  // Page load while beta already waits: the first report is the broker's placeholder, corrected a moment later.
  report("beta", quiet);
  advance(40);
  report("beta", waiting);
  expect(ids()).toEqual([]);
  // A later question after a settled quiet period is announced.
  report("beta", quiet);
  advance(QUIET_BEFORE_NOTICE_MS);
  report("beta", waiting);
  expect(ids()).toEqual(["beta"]);
});
