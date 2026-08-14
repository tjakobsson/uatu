import { describe, expect, test } from "bun:test";

import type { BuildSummary } from "../shared/types";
import {
  buildsMismatch,
  evaluateFreshness,
  serverIdentityKey,
  type ClientBuildIdentity,
} from "./freshness";

function serverBuild(overrides: Partial<BuildSummary> = {}): BuildSummary {
  return {
    version: "0.5.0",
    branch: "main",
    commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    commitShort: "aaaaaaa",
    release: true,
    identifier: "v0.5.0 · aaaaaaa",
    bundledWebRevision: 1,
    ...overrides,
  };
}

const matchingClient: ClientBuildIdentity = {
  version: "0.5.0",
  commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  bundledWebRevision: 1,
};

describe("buildsMismatch", () => {
  test("identical identities are in sync", () => {
    expect(buildsMismatch(matchingClient, serverBuild())).toBe(false);
  });

  test("a differing commit is a mismatch", () => {
    expect(
      buildsMismatch(matchingClient, serverBuild({ commitSha: "b".repeat(40) })),
    ).toBe(true);
  });

  test("a differing version is a mismatch even with equal commits", () => {
    expect(buildsMismatch(matchingClient, serverBuild({ version: "0.6.0" }))).toBe(true);
  });

  test("public API revisions do not participate in bundled-web freshness", () => {
    const server = {
      ...serverBuild(),
      hubApiRevision: 99,
      workspaceApiRevision: 99,
    };
    expect(buildsMismatch(matchingClient, server)).toBe(false);
  });

  test("a differing bundledWebRevision is a mismatch on its own", () => {
    expect(buildsMismatch(matchingClient, serverBuild({ bundledWebRevision: 2 }))).toBe(true);
  });

  test("a payload without a build field (pre-handshake server) is a mismatch, not a crash", () => {
    expect(buildsMismatch(matchingClient, undefined)).toBe(true);
  });

  test("an unknown commit on either side skips the commit comparison", () => {
    // Dev serving can't embed a commit in the browser bundle; version and
    // bundledWebRevision still compares; the commit check just can't.
    const devClient = { ...matchingClient, commitSha: "unknown" };
    expect(buildsMismatch(devClient, serverBuild({ commitSha: "b".repeat(40) }))).toBe(false);
    expect(buildsMismatch(matchingClient, serverBuild({ commitSha: "unknown" }))).toBe(false);
    expect(buildsMismatch(devClient, serverBuild({ version: "0.6.0" }))).toBe(true);
  });
});

describe("evaluateFreshness — reload loop protection", () => {
  const newServer = serverBuild({ commitSha: "b".repeat(40), commitShort: "bbbbbbb" });

  test("in-sync identities never reload", () => {
    expect(evaluateFreshness(matchingClient, serverBuild(), null)).toBe("in-sync");
    // Even a leftover marker from an earlier skew changes nothing.
    expect(
      evaluateFreshness(matchingClient, serverBuild(), serverIdentityKey(serverBuild())),
    ).toBe("in-sync");
  });

  test("a first mismatch reloads", () => {
    expect(evaluateFreshness(matchingClient, newServer, null)).toBe("reload");
  });

  test("a persisting mismatch after the reload surfaces the notice, never a second reload", () => {
    const marker = serverIdentityKey(newServer);
    expect(evaluateFreshness(matchingClient, newServer, marker)).toBe("notice");
  });

  test("a NEW server identity re-arms the automatic reload", () => {
    const staleMarker = serverIdentityKey(newServer);
    const evenNewerServer = serverBuild({ commitSha: "c".repeat(40), commitShort: "ccccccc" });
    expect(evaluateFreshness(matchingClient, evenNewerServer, staleMarker)).toBe("reload");
  });

  test("a pre-handshake server follows the same reload-once-then-notice path with a stable key", () => {
    expect(serverIdentityKey(undefined)).toBe(serverIdentityKey(undefined));
    expect(evaluateFreshness(matchingClient, undefined, null)).toBe("reload");
    expect(
      evaluateFreshness(matchingClient, undefined, serverIdentityKey(undefined)),
    ).toBe("notice");
  });

  test("a bundledWebRevision break follows the same reload-once-then-notice path", () => {
    const contractBreak = serverBuild({ bundledWebRevision: 2 });
    expect(evaluateFreshness(matchingClient, contractBreak, null)).toBe("reload");
    expect(
      evaluateFreshness(matchingClient, contractBreak, serverIdentityKey(contractBreak)),
    ).toBe("notice");
  });
});
