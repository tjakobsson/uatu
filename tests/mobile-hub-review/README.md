# Isolated mobile Hub review

**Mock backend; do not enter real credentials.** This is actual frontend behavior
against synthetic protocols, not live-backend correctness, visual approval or
authorization to expose a tailnet endpoint. Tests stop their own launcher.

## Commands

```sh
# Launcher checks the port and refuses an occupied listener. Loopback only.
lsof -nP -iTCP:4703 -sTCP:LISTEN
bun tests/mobile-hub-review/server.ts
# Controller: http://127.0.0.1:4703/review/controller
# Hub: http://127.0.0.1:4703/
# Actual workspace: http://127.0.0.1:4703/s/atlas/README.md
# Stop that foreground launcher with Ctrl-C.

bun test tests/mobile-hub-review
bunx --no-install tsc --noEmit --pretty false -p tests/mobile-hub-review/tsconfig.json
bunx --no-install playwright test --config playwright.mobile-hub-review.config.ts management.e2e.ts clients.e2e.ts
# Full review suite (includes other owners' continuity/visual tests):
bunx --no-install playwright test --config playwright.mobile-hub-review.config.ts
```

No dependency install is required with the existing project tools/browsers. No
live cookies or Authorization are consumed, forwarded or set. Runtime operations
are memory-only; filesystem reads are restricted to fixed frontend build/assets.
No request chooses a host file. Exact routes/assets, same-origin checks, loopback
Host checks, no CORS/proxy and a same-origin CSP prevent fallback to live services.
Unknown operations/routes fail closed. Missing-route logs retain bounded method/
contract labels, never supplied URL, header, body or secret text.

For managed background hosting, use `bun tests/mobile-hub-review/manage.ts start`:
with no hosting configuration it is local-only on `127.0.0.1:4703`. Remote origin
allowlisting requires an explicit runtime `--public-origin` or
`UATU_MOBILE_REVIEW_PUBLIC_ORIGIN`; there is no committed public address. Keep
actual routing details local and redact runtime output before sharing. An
unconfigured `restart` preserves the verified existing port/origin (including
older ownership records); `status`, `reset`, and `stop` use that record, not current
environment settings. See [hosting.md](hosting.md) for lifecycle and security rules.

## Assembly and controls

`startReviewServer({ port?, assets? })` returns `{ url, synthetic, protocols, stop }`.
The actual `src/index.html` graph is bundled with `browser-entry.ts` substituted
as the test entry. The product mobile frontend/coordinator and resident workspace
share one document. `/`, `/settings`, `/clone`, validated detail queries and
`/s/atlas/README.md` are available. The explicit HTTP operation allowlist in
`transport.ts` implements `MobileHubBackend` against **the same** server fixture;
there is no second browser model. Invalidations and clone events use SSE; terminal
output uses the actual xterm client's WebSocket framing.

The controller is a separate page, not a banner/control overlay in the product
viewport. It offers all nine scenarios (`mixed`, `empty`, `signed-out`, `branches`,
`credentials`, `nested`, `unavailable-tools`, `all-running`, `all-stopped`) and every
exported management control. Select a control and edit its JSON argument array.
Examples are typed against the backend factory; runtime dispatch accepts only
the explicit control names, exact arity and primitive argument types, with domain
validation in the backend. `inspect`, `backend`, `reset`, prototype properties and
arbitrary RPC fallback are not callable control names.

Use `hold`/`settle`/`fail` with a method name; `advance` takes milliseconds. Reset
clears pending gates/failures/clock/model/jobs and rejects old pending effects.
Key/tool/credential availability, devices, stop/unlock/import failures, folder and
onboarding partial outcomes, clone phases/output/completion/expiry/disconnection
are selectable. Clone controls require the **accepted job id** shown in public
state, not their example id. Refresh public state to inspect pending operations
and jobs. Upload hold/settle/fail and Chat/terminal output buttons remain available.

See [backend-guide.md](backend-guide.md) for exact control enums, fixture ids,
outcome semantics and privileged behavior intentionally not simulated. Public
state contains detached DTOs and safe synthetic facts; no private material,
submitted clone URLs or input are logged. The transport does not invent a `locked`
field or a saved-override field absent from public DTOs. Lock readiness remains
layered; detected tool paths are not presented as proven saved overrides.

## Verified management/browser evidence

The focused command above passed **28 tests: 14 each in installed Chromium and
WebKit**, using actual rendered frontend forms and the server transport:

* Actual Preview/Chat/upload/xterm clients boot at the canonical workspace URL;
  held attachment upload settles without losing the real composer draft, and
  background Chat output renders after returning from Terminal.
* SSH paste import is visually masked and clears paste/passphrase before a held
  failure; SSH generation creates one credential and displays synthetic public
  key material. OpenPGP file import clears the file input and exposes no SSH lock.
* Token creation masks/clears its input, exposes no public-key/unlock actions,
  then supports disable, enable and confirmed deletion. Fixture state excludes
  submitted disposable secrets.
* Tool override changes the path without changing a missing binary to ready;
  explicit tool recovery/Test and clearing the override use discovery truthfully.
* Assignment review has no effect before Apply, Back retains selections, cancelling
  coordinated removal does not stop Atlas, and injected stop failure preserves
  the assignment.
* Creating an empty folder does not register a workspace; configuring that folder
  requires explicit Git-init consent and registers it stopped. Registration failure
  presents a retained checkout and a working recovery browse action, not a made-up
  workspace.
* Independent clone unlock creates no job. One explicit reviewed submit creates
  exactly one job. Prompt input is always password-masked, immediately cleared and
  replayed only as `[masked input accepted]`. Disconnect/reconnect retains that job;
  cancellation cleans its synthetic checkout. Success, registration/start/cleanup
  failure and timeout each render their distinct terminal/retained-state outcome.
* Invalid login clears its password; correct simulation login succeeds;
  authoritative unauthorized invalidation returns to login and protected HTTP
  Hub state returns 401.

Unit verification: **46 Bun tests, 520 assertions passed** across backend,
protocols, server and transport. Server/transport checks include loopback lifecycle,
unknown route/control/arity rejection, all reset scenarios, pending reset guards,
safe diagnostic substitution, actual frontend bundling, bounded File encoding,
clone cursor replay/masked input/reset unavailability and personal-state semantics.
The final strengthened import-failure and clone replay assertions were rerun in
both browsers (four passing tests). The focused TypeScript project currently has
an external-owner error at `visual.e2e.ts:76`: `Property 'remove' does not exist on
type 'Node'`; it is not reported as passing here.
An explicit strict `tsc --ignoreConfig --noEmit` invocation over this worker's
server/controller/transport/client/management test files and `src/styles.d.ts`
passed. Port 4703 had no listener after verification.

## Acceptance limits and remaining work

This evidence supports the assembly/control/management portions of tasks 2.1–2.4
and automated behavior portions of task 5, **not blanket task completion**.
Full screen-map visual provenance, reference comparisons, physical-device review,
human approval, product shipping-bundle audit and live adapter integration belong
to the lead/other owners. Their continuity/visual tests are separate from the
focused counts above.

The management E2Es are substantive feature coverage, not exhaustive browser
coverage of every backend validation branch. Remaining browser matrix includes
OpenPGP generation, SSH individual lock/unlock failure, provider-token projected
dependency revocation, nested folder partial-stop ordering, all onboarding recovery
faults, auth rate limits/device revocation, clone expiry and finish/cancel races.
The backend suite covers many of these model semantics; that does not prove their
complete UI presentation. Real cryptography, executable detection, shell/Git/PTY,
filesystem recovery and provider execution are intentionally absent. The synthetic
workspace corpus does not claim every Chat/terminal/document protocol feature.
# Folder chooser reference

At `/review/design-system`, **Choose Hub folder** runs the production
`createFolderPicker` and `createTaskView`, not a copied chooser. Folder rows
traverse; the header **Choose** selects the current path into local status.
Cancel or Escape discards the selection and returns focus to the catalog.
The test-only adapter implements `FolderPickerEnvironment`: a read-only
`browseFolders` backend plus task, sheet, current-generation and auth ownership
hooks. Cancellation invokes the picker's callback before restoring the catalog,
so obsolete reads cannot update a dismissed task.

Only `/example`, `/example/projects`, `/example/projects/docs` and
`/example/empty` exist in the static client tree. **Unavailable** demonstrates
the product error/recovery UI with a typed unavailable read result. No HTTP
model calls, filesystem reads, folder creation or workspace mutations occur.
All chooser controls and styling come from production modules and follow the
device appearance. Existing editor, review and confirmation demos remain local.
# Preview exploration and recognizable Hub controls

Open **Atlas → Files → examples → START-HERE.md** for six new linked Markdown
and AsciiDoc examples. They cover tables, code, local images, Mermaid flow/sequence
diagrams, nested folders and cross-document links. The same examples are available
in Notes after synthetic Start. Existing README/continuity fixtures are retained.
Use the real Source/Rendered and diagram viewer controls; no workspace redesign
or live filesystem access is involved. The test server explicitly snapshots the
installed Mermaid library for its normal lazy route.

Hub commands now share primary/secondary/destructive button styles. Verified empty
collections have a structured icon/title/explanation; a folder-only picker says
No subfolders, not that the folder has no files. See the current OpenSpec
`review-evidence/preview-refinement/verification.md` for screenshots and limits.

Focused checks (disposable loopback **4731**, never the published 4703 reviewer):

```sh
UATU_REVIEW_PICKER_EVIDENCE="openspec/changes/restore-refined-mobile-hub-experience/review-evidence/preview-refinement/folder-picker" UATU_REVIEW_PREVIEW_EVIDENCE="openspec/changes/restore-refined-mobile-hub-experience/review-evidence/preview-refinement/previews" bunx --no-install playwright test --config tests/mobile-hub-review/preview-refinement.config.ts
bunx --no-install playwright test --config tests/mobile-hub-review/preview-boundary.config.ts
```
# Public report privacy

Raw Playwright JSON may include personal absolute checkout paths. Before retaining
or publishing a report, replace its checkout prefix with `<REPO_ROOT>` and run
`bun test tests/mobile-hub-review/privacy.test.ts`. Keep the remaining report data,
including results and failures, intact. Raw reports belong in ignored local output;
do not assume running the JSON reporter produces publication-safe content.
