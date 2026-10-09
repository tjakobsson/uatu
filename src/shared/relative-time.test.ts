import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commitAgeRefreshMs, formatCommitAge } from "./relative-time";

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const ago = (seconds: number) => formatCommitAge(NOW - seconds * 1000, NOW);
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

describe("formatCommitAge follows Git's %cr", () => {
  test("seconds up to 89", () => {
    expect(ago(0)).toBe("0 seconds ago");
    expect(ago(1)).toBe("1 second ago");
    expect(ago(89)).toBe("89 seconds ago");
  });

  test("minutes from 90 seconds, rounded to the nearest minute, up to 89", () => {
    expect(ago(90)).toBe("2 minutes ago");
    expect(ago(89 * MINUTE + 29)).toBe("89 minutes ago");
    expect(ago(89 * MINUTE + 30)).toBe("2 hours ago");
  });

  test("hours up to 35, then days", () => {
    expect(ago(3 * HOUR)).toBe("3 hours ago");
    expect(ago(35 * HOUR + 29 * MINUTE)).toBe("35 hours ago");
    expect(ago(36 * HOUR)).toBe("2 days ago");
  });

  test("a day is still hours; days up to 13, then weeks up to 69 days", () => {
    expect(ago(DAY)).toBe("24 hours ago");
    expect(ago(13 * DAY)).toBe("13 days ago");
    expect(ago(14 * DAY)).toBe("2 weeks ago");
    expect(ago(69 * DAY)).toBe("10 weeks ago");
  });

  test("months from 70 days up to a year", () => {
    expect(ago(70 * DAY)).toBe("2 months ago");
    expect(ago(364 * DAY)).toBe("12 months ago");
  });

  test("years and months up to five years, then years", () => {
    expect(ago(365 * DAY)).toBe("1 year ago");
    expect(ago((365 + 100) * DAY)).toBe("1 year, 3 months ago");
    expect(ago(1825 * DAY)).toBe("5 years ago");
    expect(ago(3000 * DAY)).toBe("8 years ago");
  });

  test("a commit time ahead of the clock is in the future", () => {
    expect(ago(-5)).toBe("in the future");
  });

  test("an unknown time renders nothing", () => {
    expect(formatCommitAge(Number.NaN, NOW)).toBe("");
  });
});

describe("formatCommitAge matches real Git output", () => {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

  // Offsets sit well inside each band so the seconds between Git's clock read
  // and ours cannot cross a boundary.
  test("for an age in every band", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "uatu-relative-time-"));
    directories.push(repo);
    const run = async (args: string[], env: Record<string, string> = {}) => {
      const child = Bun.spawn(["git", ...args], { cwd: repo, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
      const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return out.trim();
    };
    await run(["init", "--quiet"]);
    for (const seconds of [40, 20 * MINUTE, 5 * HOUR, 6 * DAY, 30 * DAY, 200 * DAY, 800 * DAY, 3000 * DAY]) {
      const when = new Date(Date.now() - seconds * 1000).toISOString();
      await run(["-c", "user.name=T", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", String(seconds)],
        { GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when });
      const [ct, cr] = (await run(["log", "-1", "--format=%ct%x09%cr"])).split("\t");
      expect(formatCommitAge(Number(ct) * 1000, Date.now())).toBe(cr!);
    }
  }, 30_000);
});

test("ages under an hour redraw every 30 seconds, older ones every 5 minutes", () => {
  expect(commitAgeRefreshMs(NOW - 10 * MINUTE * 1000, NOW)).toBe(30_000);
  expect(commitAgeRefreshMs(NOW - 2 * HOUR * 1000, NOW)).toBe(300_000);
});
