# Synthetic management backend integration guide

**Mock backend; do not enter real credentials.** All keys, tools, paths, devices,
clone work and readiness facts below are fictional. This guide covers the typed
management model, not the controller page, browser transport, visual approval or
live backend correctness.

## Factory and compatibility

```ts
import { createSyntheticBackend } from "./backend";

const review = createSyntheticBackend();
// Pass this exact instance through the test transport to mountMobileHub.
const backend = review.backend; // MobileHubBackend — every method implemented
```

Existing `backend`, `workspaceAvailable()`, `snapshot()`, `hold`, `settle`,
`advance` and `reset` are preserved. `snapshot()` retains its original fields:
`clock`, `authenticated`, `log`, `pending`. New `inspect()` returns detached
public workspace/credential/tool/device/default-folder/folder/job projections.
Neither projection contains passwords, passphrases, tokens, uploaded Files,
private-key text, clone URLs, clone input, raw command output or diagnostics.
Public display names, usernames, host selections and synthetic paths are public
model data, not mutation-log arguments. Logs are bounded to 500 entries and
record only method, outcome, sequence and fixture-clock time.

Keep one factory instance behind the explicit transport allowlist. Do not expose
all object properties via a generic RPC fallback. Controller methods below are
test-only; they do not belong on `MobileHubBackend` or in product Settings.

## Approved additive frontend contract (tasks 1.4 / 1.5)

No public HTTP API or existing credential/tool DTO changed. The three new
frontend-only methods are:

```ts
readCredentialFacts(target: CredentialTarget): Promise<ReadResult<CredentialFacts>>;
readToolConfiguration(tool: CredentialTool): Promise<ReadResult<ToolConfiguration>>;
reconcileCloneAttempt({ attemptId }: { attemptId: string }): Promise<ReadResult<CloneAttemptState>>;
```

`CredentialFacts` has `id`, `type`, `protection`, `lock`, `userId`. For SSH and
OpenPGP, protection is `{status:"known", value:"protected"|"unprotected"}` or
`{status:"unknown"}`; lock is independently `{status:"known",
value:"locked"|"unlocked"}` or unknown. OpenPGP user ID is a known string or
unknown. SSH user ID and **all three token facts** are `{status:"not-applicable"}`.
Unknown/inapplicable facts cannot carry a value. An unprotected SSH key can still
be explicitly locked; do not collapse protection into lock state. Disabled is
still the existing DTO's `enabled:false`, not a protection fact.

`ToolConfiguration` is `{tool, savedOverride: {status:"known", value:string|null}
| {status:"unknown"}}`. Known null means **no saved override**; it is not the
detected effective path. Keep Test diagnostics separate. Unknown must not seed a
draft with the effective path. User ID, lock and override facts must never be
recovered by parsing public-key comments, names or readiness messages.

New controls: `setCredentialFactsUnknown(id, boolean)`,
`setOpenPgpUserId(id, string|null)` (null = unknown),
`setToolConfigurationUnknown(tool, boolean)`, `expireCloneAttempt(attemptId)`.
`GET /review/capabilities` advertises these controls/read methods and their state
vocabulary. Controller state includes `credentialFacts`, `toolConfiguration` and
current-authentication `attempts`. The test transport explicitly allowlists all
three reads and validates their discriminants/target identities.

### Clone attempt ownership and reconciliation rules

`CloneIntent` remains the non-secret draft type. **Submission now requires**
`CloneSubmissionIntent = CloneIntent & {attemptId:string}`. Mint an opaque id once
before dispatch (e.g. `crypto.randomUUID()`), and retain that exact id across
network loss, in-document navigation and reload. Review IDs accept 8–128 ASCII
letters/digits/underscores/hyphens, starting with a letter or digit. Never derive
an id from a URL or secret. Old UI callers must add the field; it is not optional.

`CloneAttemptState` is one of:

* `{status:"accepted", jobId}` — subscribe/reconnect to this exact job. Repeated
  submit with the same id returns that original job; changed retry arguments
  cannot create another job.
* `{status:"pending"}` — the original admission is still unresolved; reconcile
  later. No replacement submit and no “not submitted” copy.
* `{status:"not-accepted"}` — authoritative and **fenced**, even for an id whose
  original HTTP request has not arrived. A later submit with that id is rejected.
  A newly authorized submission may mint a NEW id.
* `{status:"expired"}` — the attempt/result is no longer authoritative enough
  for safe retry. Do not infer no work from absent registration or job inventory.

ReadResult `unavailable` is separate from all four states and **never** means
not-accepted. Only a definitive rejected/requires-unlock reply or authoritative
not-accepted lookup permits a fresh, explicitly authorized attempt. In particular,
a requires-unlock response concludes that attempt without admission: after
unlock, the authorized continuation submits with a new id, not the concluded id.

The server records pending before its hold gate; duplicate in-flight calls share
the same admission, and after-effect response loss keeps its accepted job ID.
`fail("submitClone", "indeterminate-before")` reconciles as fenced not-accepted;
`"indeterminate-after"` reconciles as accepted. The browser transport maps network
loss/non-authoritative response failure to indeterminate, not rejected.
`expireCloneAttempt` can expire a pending gate, which then cannot commit later.
It does not cancel already accepted jobs. Job replay expiration also makes the
corresponding lookup expired.

Attempts/jobs are owned by the captured synthetic authentication context.
Sign-out/revoke/unauthorized changes that context; new sign-in cannot inspect or
mutate an older context's job or obtain its accepted id by reconciliation. Reload
against the same running server/authentication context can reconcile normally.
Reset clears jobs and invalidates pending calls while retaining opaque attempt
tombstones: a pre-reset id yields unavailable, **not** an invented not-accepted.
No URL, digest of a URL/secret, credentials, File or clone-input text is retained
in an attempt record. There is no production/live idempotency claim.

Management File serialization now transmits **size only**, never its bytes or
filename. The decoder makes a zero-filled synthetic placeholder. This is separate
from actual workspace Chat attachment uploads. It lets file-source/size UI run
without transporting private-key material into the review backend.

## Fixture identities and reset scenarios

Simulation login: **reviewer / review-only**. Authentication never consults or
sets live cookies. Current device handle: `review-device`; another device:
`review-other-device`. Issued timestamps are not last-active timestamps.

| Scenario | Contents |
| --- | --- |
| `mixed` (default) | Running Atlas (`atlas`), stopped Notes (`notes`), populated credential/tool catalog, no assignments. |
| `empty` | No workspaces or credentials; synthetic browse tree and tools remain. |
| `signed-out` | Protected reads fail; authentication read reveals signed-out only. |
| `credentials` | Atlas projected `token-github`; Notes assigned locked SSH authentication and locked OpenPGP signing. |
| `branches` | Named, unborn, detached, non-Git, loading and unavailable facts; duplicate Notes labels have different stable ids/paths. |
| `nested` | Adds running `nested-parent` at `/synthetic/group` and running `nested-child` at `/synthetic/group/child`. |
| `unavailable-tools` | Missing binaries plus incompatible Git version. |
| `all-running`, `all-stopped` | Whole dashboard in one truthful runtime group. |

Credential IDs:

* `ssh-locked`: protected SSH authentication **and** signing, initially locked.
* `ssh-open`: unprotected SSH authentication; individual lock and empty-passphrase
  unlock are supported without changing its protection facts.
* `pgp-locked`: OpenPGP signing, initially locked; **no individual lock**.
* `token-github`: enabled HTTPS Git + GitHub CLI at `github.com`.
* `token-gitlab`: disabled HTTPS Git + GitLab CLI at `gitlab.com`.

Folders include `/synthetic/existing` (unregistered Git checkout),
`/synthetic/empty-folder` (unregistered, empty, non-Git), `/synthetic/denied`
(permission unavailable), `/synthetic/group`, and registered workspace folders.
Browse, folder mutations, workspace creation and tool overrides accept the
**synthetic namespace only**. Entering a real host path is not a request to inspect
it. No symlink/realpath, filesystem, Git or executable is consulted.

Reset replaces all model state, failures, pending gates, tool overrides, key
states, projected credentials, default folder, jobs/replay and fixture counters.
It invalidates old pending operations and every catalog subscription; old clone
subscriptions receive explicit unavailability. Invalidation generations remain
monotonic across reset. An old pending call may subsequently add a **rejected**
log entry, but cannot mutate the new fixture.

## Delay, failure and clock controls

```ts
review.hold("generateSsh");
const pending = backend.generateSsh({
  name: "Review key", capabilities: ["ssh-authentication"],
  passphrase: "disposable-example-only",
});
// pending appears in snapshot(); secret fields have already been discarded.
review.settle("generateSsh"); // release successfully and clear that method's fault
await pending;

review.hold("stopWorkspace");
// ...submit through actual frontend...
review.settle("stopWorkspace", true); // release with synthetic unavailable error
review.fail("readCredentials", { kind: "forbidden", message: "ignored" });
review.fail("signIn", { kind: "rate-limited", message: "ignored", retryAfterSeconds: 30 });
review.fail("renameWorkspace", "indeterminate-after"); // effect commits, response lost
review.fail("stopWorkspace", "indeterminate-before"); // no effect; acceptance unknown
review.fail("renameWorkspace", null); // clear fault without releasing its hold
review.advance(1000); // explicit stable-clock advance; no wall-clock timer
```

`fail` replaces supplied diagnostic text with fixed synthetic messages, including
when a controller accidentally passes private text. Unknown method names, unknown
scenario names and unsupported control states reject. Reads return typed
unavailability; operations return typed rejection or indeterminate results, never
a generic successful placeholder. There are no `missing-contract` operation
stubs left in this backend.

Additional controls:

* `setKeyState(id, "locked" | "unlocked" | "unprotected" | "unavailable")`
* `setCredentialAvailable(id, boolean)` — missing synthetic private material,
  independently of the enabled flag (also applies to tokens).
* `setToolState(tool, "ready" | "missing" | "incompatible" | "runtime-unavailable")`
* `setStopFailure(workspaceId, boolean = true)`
* `setUnlockFailure(boolean = true)` / `setImportFailure(boolean = true)`
* `setFolderAvailable(path, boolean)` — can make the saved default unavailable,
  retaining its configured value while effective browse falls back to `/synthetic`.
* `setDeviceInventory("empty" | "current-only" | "multiple")`
* `invalidateAuthentication()` — authoritative synthetic unauthorized event.

Tool override changes only the selected synthetic path. It does **not** magically
turn a missing/incompatible tool into a ready executable. Choose the corresponding
tool state explicitly before Test to show recovery. Required-tool, runtime,
credential and capability layers remain independently visible.

## Credential and assignment semantics

Every credential read conforms to `PublicCredentialDto`; every tool read conforms
to `PublicToolReadinessDto`. There is no new `locked` wire field: contextual
layered readiness expresses lock state using the existing DTO.

* Generate SSH/OpenPGP requires nonempty bounded passphrase; SSH capabilities
  must be nonempty and supported. OpenPGP user ID is validated and represented
  in a clearly synthetic public-key comment; the DTO has no separate user-ID
  property and no fabricated property is added.
* Import validates exactly one source and the 1 MiB limit **without reading a
  File**. Paste is checked only for nonempty/size/NUL. The model intentionally
  does not parse real cryptographic material. Set `setImportFailure()` for invalid
  format/key-capability/decoding presentation; otherwise use disposable opaque
  text. SSH import with a passphrase finishes unlocked; without one, unprotected.
* No secret is stored or compared later. Unlock requires appropriate nonempty
  input for protected keys and is controlled by `setUnlockFailure`. Successful
  unlock never starts a workspace or submits a clone by itself.
* Public key lookup is SSH/OpenPGP only. Returned public strings unmistakably say
  `SYNTHETIC-PUBLIC-ONLY` and are **not usable keys**. Tokens have no public key,
  passphrase unlock or lock action. OpenPGP has no individual lock action.
* Tokens require a normalized HTTPS host and valid, bounded single-line secret.
  HTTPS Git / GitHub CLI / GitLab CLI capabilities are represented; selecting both
  provider CLI capabilities or a token-assignment host mismatch fails.
* `assignWorkspace` validates both selected roles before committing either.
  Unselected roles and other authentication hosts remain unchanged. Both frontend
  modes map to the existing replace-selected-slots operation; mode does not
  silently remove a previous host. `assignCredential(replace: false)` rejects a
  conflicting slot; an exact no-op does not emit catalog mutation events.
* Removing an assignment uses `needs-stop` with no side effect until confirmed.
  Stops happen in stable id order **before** catalog mutation. A stop failure
  leaves the catalog unchanged, even if earlier dependent workspaces stopped.
* Provider CLI token disable/delete consults the credentials projected at each
  workspace's start, **not only current assignments**. Editing current assignments
  does not erase a running process's dependency. Deletion also requires explicit
  confirmation and unassign consent when referenced. SSH/OpenPGP individual
  revocation follows its distinct semantics; no provider-token policy is invented
  for those key types.
* Start distinguishes already-running, confirm-unassigned, unavailable/disabled
  assignments, a list of keys requiring unlock, and successful start. Changed
  assignments/configuration update `credentialRestartRequired`; no-op/reverted
  configuration is compared with the running revision. Stop clears its projection.

## Folder/onboarding controls and partial outcomes

Folder creation is not workspace creation. Existing non-Git folder configuration
requires `init: true`; new workspace creation requires `gitInitConsent: "confirmed"`.
Display names remain distinct from folder names and stable registration IDs.
Already-registered Existing folder returns the idempotent registration facts and
does not rename, reassign or start it.

Nested folder rename stops affected registered descendants before updating all
synthetic path prefixes, keeping ids and display names. An exact no-op avoids
stopping. Collision, root/reserved path, hidden/invalid names, inaccessible and
nonempty removal fail explicitly. Empty registered-folder removal forgets that
registration/assignments, but nonempty/Git folders are not deleted. Forget alone
removes registration and assignments, never a folder.

```ts
review.setFolderFault("before-mutation");
review.setFolderFault("after-stop"); // stop succeeds; folder/catalog operation fails
review.setFolderFault(null);

review.setOnboardingFault("needs-init");
review.setOnboardingFault("credential");
review.setOnboardingFault("git-init");
review.setOnboardingFault("register-failed");
review.setOnboardingFault("retained-checkout");
review.setOnboardingFault("committed-recovery");
review.setOnboardingFault("start-failed");
review.setOnboardingFault(null);
```

Preflight failures of new-workspace creation remove its empty synthetic folder.
Registration/recovery failures can retain a checkout without registration;
committed recovery returns `committedEntry`; start failure retains a configured,
stopped workspace and reports `startError`. These are simulated **outcomes**, not
filesystem/journal recovery implementations.

## Clone controls, stream contract and lifecycle

```ts
const submitted = await backend.submitClone({
  attemptId: "review-attempt-1", // mint once before dispatch; retain for reconciliation
  url: "https://github.com/review/example.git", dest: "/synthetic",
  folderName: "checkout", displayName: "Review checkout",
  credentialId: "token-github", retainedAuthentication: [], signing: null,
  start: false,
});
// After typed accepted result, retain that exact job id and subscribe/reconnect.
// If requires-unlock, unlock independently and submit once only when authorized.

review.cloneOutput(jobId, "progress");
review.cloneOutput(jobId, "prompt"); // any apparent prompt still uses masked input
review.clonePhase(jobId, "registering");
review.clonePhase(jobId, "starting"); // requires original start:true; registration is now visible stopped
review.disconnectClone(jobId); // disconnect only, does not cancel/resubmit
review.finishClone(jobId, "succeeded");
```

* SSH/HTTPS transport and selected identity capability/host/enabled/tool/key
  state are checked. Remote URL path/userinfo/query text is never retained. HTTPS
  embedded credentials and URL query/fragment secrets are rejected.
* One-time clone identity is not a retained assignment. Retained auth and signing
  are separate selections validated atomically. Active jobs reserve their target,
  preventing duplicate submission and overlapping folder mutation.
* `subscribeClone({jobId, afterEventId}, listener)` replays typed monotonic domain
  events after the cursor. Unsubscribe/navigation is not cancellation. Invalid
  cursors reject; bounded replay gaps, expiration and auth loss report explicit
  unavailability. Disconnect produces a distinct nonterminal event.
* `sendCloneInput` accepts bounded text only while cloning, not while registering,
  starting or terminal. It keeps only a validation fact and emits literal
  `[masked input accepted]`, never supplied text or an echo. No raw-output control
  accepts arbitrary strings.
* `finishClone` accepts `succeeded`, `clone-failed`, `register-failed`,
  `start-failed`, `cleanup-failed`, `cancelled`, `timed-out`. Success may be stopped
  or explicitly started. Start-failed retains its registered workspace; register/
  cleanup failures retain a checkout; cleanup-failed after registration includes
  its retained workspace id. An impossible terminal control (e.g. start-failed
  without start intent) rejects rather than inventing a success.
* `setCloneCleanupFailure(true)` changes cancellation to a truthful retained-
  checkout cleanup failure. Otherwise cancellation cleans the synthetic checkout
  and partial registration. Finish-before-cancel makes cancellation report
  `terminal`. A held cancel or held submit can model races through normal methods.
* `advance(ms)` models ten-minute inactivity, one-hour lifetime, and five-minute
  terminal retention. `expireClone(jobId)` permits explicit terminal expiry.
  No wall-clock timer, process, shell, Git invocation or provider is started.

## Verification and remaining ownership boundary

`backend.ts` and `management-model.ts` import product domain types **type-only**.
Tests use the pure public DTO validators to catch contract drift. All backend
methods have real typed synthetic implementations; the tests exercise every
operation, major validation branch, consent/failure ordering, reset/generation
guard, and terminal/partial outcome.

```sh
bun test tests/mobile-hub-review/backend.test.ts
bunx --no-install tsc --ignoreConfig --noEmit --pretty false \
  --target ESNext --module ESNext --moduleResolution Bundler \
  --resolveJsonModule --strict --types bun-types --skipLibCheck \
  tests/mobile-hub-review/backend.ts tests/mobile-hub-review/backend.test.ts \
  tests/mobile-hub-review/management-model.ts src/styles.d.ts
```

Deferred by design: actual cryptographic format checks, private-file reads,
executable/version detection, real path/symlink/journal recovery, network auth,
clone/provider/PTY execution and live enforcement. The model supplies their
reviewable outcomes, not those privileged implementations. Exact production
wire validation is still owned by later live adapters.

Controller-page/transport allowlisting and UI reachability of these new controls
belong to the other implementation agents. Full screen-map/visual/browser
acceptance and task 2.4 completion cannot be claimed from these model tests alone.
No services need to run to verify this backend; no task checklist is changed here.
