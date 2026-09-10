import { describe, expect, test } from "bun:test";
import type {
  AssignmentSelection, AuthenticationState, BranchState, CloneCancellation,
  CloneProgress, CloneSubmission, ConfiguredWorkspaceResult, CoordinatedResult,
  CreateNewWorkspaceIntent, Invalidation, MobileHubBackend, OperationResult,
  PrivateKeySource, WorkspaceRuntime, CredentialFacts, ToolConfiguration, CloneAttemptState, CloneIntent,
} from "./backend";
import type { CloneJobResult } from "../clone-jobs";
import type { CredentialAssignment } from "../credential-types";

// These are compile-time contracts, deliberately never invoked. `bun test`
// does not type-check; run `bun run typecheck` as well. Every expected error
// becomes a typecheck failure if the contract accidentally grows permissive.
function typeContracts(backend: MobileHubBackend, file: File) {
  const named: BranchState = { kind: "named", name: "topic" };
  const detached: BranchState = { kind: "detached", commit: "0123456" };
  const unborn: BranchState = { kind: "unborn", name: "topic" };
  // @ts-expect-error detached HEAD cannot also claim a named branch
  const ambiguous: BranchState = { kind: "detached", commit: "0123456", name: "topic" };
  // @ts-expect-error an unborn branch has no commit
  const born: BranchState = { kind: "unborn", name: "topic", commit: "0123456" };
  // @ts-expect-error no guessed branch in unavailable state
  const fabricated: BranchState = { kind: "unavailable", message: "Offline", name: "main" };
  // @ts-expect-error a named branch requires its name
  const unnamed: BranchState = { kind: "named" };
  // @ts-expect-error stopped workspaces cannot claim live shells
  const stopped: WorkspaceRuntime = { status: "stopped", shells: { status: "ready", value: [] } };
  // @ts-expect-error authentication loss cannot retain protected identity data
  const disclosed: AuthenticationState = { status: "signed-out", identity: { user: "user", host: "host", version: "v" } };
  // @ts-expect-error sources are mutually exclusive even on structurally assigned variables
  const source: PrivateKeySource = { kind: "file", file, text: "private material" };
  // @ts-expect-error signing has no authentication host and authentication requires one
  const assignment: CredentialAssignment = { role: "authentication", workspaceId: "w", credentialId: "c" };
  // @ts-expect-error an assignment operation must select at least one role
  const noSelection: AssignmentSelection = {};
  const dualRole: AssignmentSelection = { authentication: { credentialId: "a", host: "example.test" }, signing: { credentialId: "s" } };
  // @ts-expect-error tokens have no public key
  backend.readPublicKey({ id: "c", type: "token" });
  // @ts-expect-error OpenPGP has no individual lock operation
  backend.lockSsh({ id: "c", type: "openpgp" });
  // @ts-expect-error tokens cannot be unlocked with passphrases
  backend.unlockCredential({ target: { id: "c", type: "token" }, passphrase: "" });
  // @ts-expect-error destructive confirmation must be affirmative
  backend.deleteCredential({ target: { id: "c", type: "ssh" }, confirm: false, unassign: false, stop: "ask" });
  // @ts-expect-error no success payload can accompany an indeterminate mutation
  const unknown: OperationResult<string> = { status: "indeterminate", message: "Disconnected", value: "success" };
  // @ts-expect-error needs-stop is not a committed catalog mutation
  const blocked: CoordinatedResult<string> = { status: "needs-stop", workspaceIds: ["w"], value: "changed" };
  // @ts-expect-error clone acceptance requires a job identity for reconnect, not a Boolean
  const accepted: CloneSubmission = { status: "accepted" };
  // @ts-expect-error active progress is not a terminal outcome
  const mixed: CloneProgress = { status: "running", phase: "cloning", result: { status: "cancelled", target: "/checkout" } };
  // @ts-expect-error cancellation acknowledgement cannot claim clone success
  const cancel: CloneCancellation = { status: "succeeded" };
  // @ts-expect-error workspace invalidation must identify the workspace
  const invalidation: Invalidation = { scope: "workspace", generation: 1, reason: "removed" };
  // @ts-expect-error creating a workspace requires explicit Git-init consent
  const creation: CreateNewWorkspaceIntent = { parent: "/parent", folderName: "folder", displayName: "Name", authentication: [], signing: null, start: false };
  // @ts-expect-error started and start-failed cannot both be true
  const impossibleStart: ConfiguredWorkspaceResult = { entry: { id: "w", path: "/p", backend: "local", displayName: "Name" }, created: true, alreadyRegistered: false, createdFolder: true, started: true, startError: "failed" };
  // @ts-expect-error idempotent existing registration cannot claim it created the folder
  const impossibleRegistration: ConfiguredWorkspaceResult = { entry: { id: "w", path: "/p", backend: "local", displayName: "Name" }, created: false, alreadyRegistered: true, createdFolder: true, started: false, startError: null };
  // @ts-expect-error token lock/protection must be not-applicable, never guessed
  const tokenFacts: CredentialFacts = { id: "t", type: "token", protection: { status: "known", value: "protected" }, lock: { status: "not-applicable" }, userId: { status: "not-applicable" } };
  // @ts-expect-error unknown saved configuration cannot carry an effective path
  const unknownOverride: ToolConfiguration = { tool: "git", savedOverride: { status: "unknown", value: "/bin/git" } };
  // @ts-expect-error not-accepted cannot name a running job
  const conflictingAttempt: CloneAttemptState = { status: "not-accepted", jobId: "job" };
  const draft: CloneIntent = { url: "https://example.test/repo", dest: "/parent", folderName: "repo", displayName: "Repo", credentialId: null, retainedAuthentication: [], signing: null, start: false };
  // @ts-expect-error submission must carry the attempt identity minted before dispatch
  backend.submitClone(draft);
  void [tokenFacts, unknownOverride, conflictingAttempt];
  void [named, detached, unborn, ambiguous, born, fabricated, unnamed, stopped,
    disclosed, source, assignment, noSelection, dualRole, unknown, blocked,
    accepted, mixed, cancel, invalidation, creation, impossibleStart, impossibleRegistration];
}
void typeContracts;

describe("mobile Hub backend contract", () => {
  test("represents all branch facts without Boolean or default-branch inference", () => {
    const values: BranchState[] = [
      { kind: "named", name: "topic" }, { kind: "detached", commit: "0123456" },
      { kind: "unborn", name: "topic" }, { kind: "non-git" },
      { kind: "loading" }, { kind: "unavailable", message: "Cannot inspect" },
    ];
    expect(new Set(values.map(value => value.kind)).size).toBe(6);
    expect(values.slice(3).every(value => !("name" in value))).toBe(true);
  });

  test("retains every existing terminal clone outcome including partial success", () => {
    const results: CloneJobResult[] = [
      { status: "succeeded", workspaceId: "w", target: "/checkout", running: false },
      { status: "succeeded", workspaceId: "w", target: "/checkout", running: true },
      { status: "clone-failed", target: "/checkout", error: "Clone failed" },
      { status: "register-failed", target: "/checkout", error: "Registration failed" },
      { status: "start-failed", target: "/checkout", workspaceId: "w", error: "Start failed" },
      { status: "cleanup-failed", target: "/checkout", error: "Cleanup failed" },
      { status: "cancelled", target: "/checkout" },
      { status: "timed-out", target: "/checkout", reason: "inactivity" },
    ];
    for (const result of results) {
      const progress: CloneProgress = { status: "finished", result };
      expect(progress.result).toBe(result);
    }
  });

  test("contains only type declarations and type-only domain imports, never fixtures or privileged runtime dependencies", async () => {
    const text = await Bun.file(new URL("./backend.ts", import.meta.url)).text();
    const allowedImports = new Set([
      "../credential-types", "../registry", "../../terminal/server", "../clone-jobs",
      "../onboarding", "../folder-manager", "../sessions", "../preferences", "../token-credentials", "../auth",
    ]);
    const declarations = [...text.matchAll(/^import\s+([\s\S]*?)\s+from\s+"([^"]+)";/gm)];
    expect(declarations).toHaveLength(allowedImports.size);
    for (const declaration of declarations) {
      expect(declaration[1]!.startsWith("type ")).toBe(true);
      expect(allowedImports.has(declaration[2]!)).toBe(true);
    }
    expect(new Bun.Transpiler({ loader: "ts" }).scanImports(text)).toEqual([]);
    // A browser build must not traverse the server managers or test fixtures.
    const result = await Bun.build({ entrypoints: [new URL("./backend.ts", import.meta.url).pathname], target: "browser" });
    expect(result.success).toBe(true);
    expect(result.outputs).toHaveLength(1);
    expect((await result.outputs[0]!.text()).trim()).toBe("");
  });
});
