## 1. Workspace Identity

- [x] 1.1 Add bounded visible display-name validation and persist `displayName` on every workspace registry entry while preserving immutable ids, paths, and backends.
- [x] 1.2 Migrate legacy registry snapshots by deriving missing display names from folder basenames and persisting the migration through the serialized atomic writer.
- [x] 1.3 Add atomic display-name updates that work for running and stopped workspaces without entering session lifecycle or folder-mutation barriers.
- [x] 1.4 Extend registry and reload tests for migration, rename persistence, duplicate display names, invalid names, concurrent mutations, and folder rename preserving display names.

## 2. Hub Workspace Preferences

- [x] 2.1 Add a versioned owner-only atomic Hub preferences store and state-directory path for an optional canonical default workspace parent.
- [x] 2.2 Implement configured/effective default resolution, direct-directory validation, clear behavior, home fallback, and unavailable-path diagnostics.
- [x] 2.3 Wire preference loading into Hub startup and make pathless directory browsing use the effective default without restricting explicit paths.
- [x] 2.4 Add persistence, permission, invalid-path, symlink, restart, unavailable-default, clear, and outside-default registration tests.

## 3. Atomic Workspace Onboarding

- [x] 3.1 Define closed configure-existing and create-new inputs with display name, authentication host/default, signing default, and explicit stopped-by-default start intent.
- [x] 3.2 Add credential-selection validation that resolves compatible authentication and signing assignments before any registry or filesystem mutation.
- [x] 3.3 Implement a versioned pending-onboarding journal and serialized coordinator that commits registry and assignment state coherently with live rollback and startup recovery.
- [x] 3.4 Implement existing-folder onboarding under the shared hierarchy reservation, retaining the legacy registration operation as an adapter with its current start behavior.
- [x] 3.5 Implement new-workspace creation under a canonical parent with no-replace folder creation, Git initialization, stopped registration, and safe empty-only pre-init cleanup.
- [x] 3.6 Preserve committed configuration when an explicitly requested first start fails and return a result that identifies the stopped workspace and startup error.
- [x] 3.7 Add failure-injection and recovery tests for every registry/assignment journal boundary, validation rollback, concurrent folder/clone/registration races, start failure, and retained initialized-folder retry.

## 4. Clone Configuration

- [x] 4.1 Extend clone-job requests and retained job state with workspace display name, separate clone and retained authentication choices, signing choice, and explicit start intent.
- [x] 4.2 Commit clone registration and retained assignments through the onboarding coordinator before any optional session start, without implicitly retaining the clone identity.
- [x] 4.3 Change successful stopped clones to report registered-workspace completion without navigation while preserving interactive output, cancellation, timeout, and requested-start behavior.
- [x] 4.4 Extend clone unit and integration tests for independent checkout/workspace names, stopped default, retained credentials, no implicit retention, signing, requested start, and start-failure preservation.

## 5. Hub API

- [x] 5.1 Add authenticated same-origin configure-existing, create-new, display-name update, and workspace-default settings handlers with closed typed success and error payloads.
- [x] 5.2 Extend Hub state and directory listings with required display names and lifecycle-aware registration data, including configured/effective default-parent status.
- [x] 5.3 Map onboarding conflicts, validation, Git initialization, partial filesystem retention, credential incompatibility, and post-commit start failure to actionable documented responses.
- [x] 5.4 Add route integration coverage for authentication, CSRF, stopped defaults, Add and start, create, rename while running, duplicate names, preferences, and atomic rollback.

## 6. Add Workspace UX

- [x] 6.1 Relabel `/clone` and shared navigation as Add workspace while preserving the route, and organize Create new, Existing folder, and Clone repository entry modes around one configuration pattern.
- [x] 6.2 Build the Existing folder Add workspace dialog with basename-derived editable display name, canonical read-only path, compatible authentication/signing selectors, Add workspace primary action, and Add and start secondary action.
- [x] 6.3 Build Create workspace with default parent, linked-until-edited folder/workspace names, credential selectors, stopped completion, destination conflicts, retained-folder recovery guidance, and local errors.
- [x] 6.4 Rework Clone repository fields to distinguish checkout folder, workspace display name, clone identity, retained authentication, signing, and Start after clone defaulting off.
- [x] 6.5 Keep controls busy through configuration and optional start, preserve forms on actionable failure, and make cancellation mutation-free across all three entry modes.
- [x] 6.6 Add responsive and accessible page tests for field labels, defaults, request payloads, stopped completion, explicit starts, credential filtering, busy/error states, and narrow layouts.

## 7. Workspace Management UX

- [x] 7.1 Render display names as primary titles with paths as secondary detail across running/stopped rows, Settings assignment summaries, confirmations, and stopped-session pages.
- [x] 7.2 Add Rename workspace for running and stopped entries and use explicit Rename folder, Remove from Hub, and Remove folder labels wherever those actions coexist.
- [x] 7.3 Make directory-browser actions state-aware so registered stopped workspaces Start through the credential-aware flow and running workspaces Open.
- [x] 7.4 Update the in-session workspace switcher to use display names, disambiguate duplicates, and Start stopped targets instead of navigating into unavailable sessions.
- [x] 7.5 Add dashboard, stopped-page, browser, and hub-navigation tests for naming, duplicate disambiguation, lifecycle actions, and stable URLs after display and folder renames.

## 8. Public Contract And Clients

- [x] 8.1 Add onboarding, display-name, preferences, clone request, Hub state, and directory-listing schemas and examples to `api/openapi.yaml`, operation inventory, route coverage, and contract tests.
- [x] 8.2 Increment the Hub API revision, add consumer migration notes, and run compatibility checks for the new required closed-response fields and changed onboarding contract.
- [x] 8.3 Update API guides to distinguish display name, URL id, folder path, registration, and session lifecycle, including stopped-by-default onboarding examples.
- [x] 8.4 Update UatuCode Desktop Hub workspace decoding and compatibility expectations for required display names and the new Hub API revision.

## 9. Verification

- [x] 9.1 Run focused registry, preferences, onboarding, clone, credential, page, navigation, Hub integration, API contract, and desktop tests and fix all failures.
- [x] 9.2 Run `bun test`, `bun run build`, `bun run api:validate`, API compatibility checks, the macOS desktop build/tests, and `openspec validate improve-hub-workspace-onboarding --strict`.
