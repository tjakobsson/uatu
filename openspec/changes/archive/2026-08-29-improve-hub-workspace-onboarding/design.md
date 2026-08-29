## Context

See `proposal.md` for motivation and the delta specs for observable behavior. The registry currently stores `{ id, path, backend }`; the id is derived from the folder basename and is used as the session URL key, personal-state key, credential-assignment key, and lifecycle key. The browser's Add action calls the existing registration endpoint without `start:false`, so registration and first start are one UI action even though stopped registration already exists in the API.

Workspace registrations and credential assignments live in separate atomic JSON stores. Clone jobs have their own lifecycle and path reservation. The folder-management change adds coordinated path reservations, registered-folder mutation journaling, and stable-id path replacement. This change must preserve those invariants while adding a mutable display name and a second metadata transaction across registration and assignments.

The Hub has multiple authenticated users but one host OS identity, registry, credential catalog, and filesystem view. The default workspace parent is therefore Hub-wide rather than personal. It is a convenience setting, not a filesystem authorization boundary.

## Goals / Non-Goals

**Goals:**

- Give each workspace one mutable human label and one immutable routing id.
- Make stopped, fully configured registration the normal onboarding result.
- Commit registration and initial credential assignments coherently before any optional first start.
- Create a new Git workspace safely under a user-selected or configured parent.
- Reuse one workspace configuration model across existing folders, newly created repositories, and clones.
- Keep old API clients diagnosable through an explicit Hub API revision and migration notes.

**Non-Goals:**

- Renaming stable ids, redirecting old `/s/<id>/` URLs, or changing personal-state keys.
- Restricting workspaces to the configured default parent.
- Changing the SPA's document-derived project title, repository badge, or identity hue.
- Providing filesystem moves between parents, recursive deletion, templates, starter files, or remote repository creation.
- Automatically selecting credentials when multiple compatible identities exist.
- Treating local-backend assignments as an OS-enforced credential boundary.

## Decisions

### 1. Add `displayName`; keep `id` immutable and visually secondary

`WorkspaceEntry` gains `displayName`. It is trimmed, 1-64 visible characters, rejects control characters, and need not be unique. Existing entries load with `path.basename(path)` as the default and the registry persists the migration through its serialized writer. Folder rename preserves `displayName`; workspace rename updates only this field.

Hub-owned UI uses `displayName` for row titles, settings, confirmations, stopped pages, and the in-session workspace switcher. Paths disambiguate duplicate names. Stable ids remain in URLs and advanced details. The child SPA still derives its own project label from watched roots because that identity describes document scope, not Hub registration.

Changing the stable id was rejected because it would migrate URLs, live session maps, personal state, assignments, clone rollback hooks, and bookmarks. Reusing the basename as the display name was rejected because it recreates the current UX after every folder rename.

### 2. Use one Add workspace page with three entry modes

Keep `/clone` as a compatible route but relabel shared navigation and the page as Add workspace. The page presents three clear entry modes using the same final configuration form:

- Create new: parent, folder name, display name, authentication, signing.
- Existing folder: directory browser followed by display name and credentials.
- Clone repository: URL, parent, checkout folder, display name, clone identity, retained authentication, signing.

Folder name and display name initially track one another until the user edits either field. Paths remain read-only outputs of the browser and parent/name controls rather than free-form destination strings. The primary completion action is Add workspace; Add and start or Start after clone is explicit and defaults off.

A multi-step wizard was rejected because these forms contain few fields and users need to compare path, name, and credentials together. Keeping separate unrelated forms was rejected because their defaults and rollback behavior have already diverged.

### 3. Add onboarding operations instead of silently changing the legacy operation

Add public authenticated operations dedicated to configured onboarding:

- `POST /api/hub/workspaces/configure` for an existing folder.
- `POST /api/hub/workspaces/create` for a new child Git repository.
- Extend clone-job creation with `displayName`, retained authentication/signing selections, and `start`.
- `POST /api/hub/workspaces/<id>/display-name` for display-name changes.
- `GET` and `POST /api/hub/settings/workspace-defaults` for the default parent.

The new configure/create operations use closed request objects and require an explicit `start` boolean whose documented default for omitted values is false. The bundled UI always sends it. The old `POST /api/hub/workspaces` remains as a compatibility shorthand with its existing start behavior until a future removal policy exists; internally it adapts into the same coordinator with a derived display name and no initial assignments.

Adding fields to the closed `HubWorkspace` response schema is incompatible under the project's contract rules even if permissive clients tolerate it. Increment the Hub API revision, document the new required `displayName` field and operations, and update the macOS model in the same change.

### 4. Put metadata onboarding behind a journaled coordinator

Create a workspace-onboarding service rather than sequencing registry and credential writes in route handlers. It validates the full request and credential compatibility before mutation, acquires the shared path reservation, and serializes onboarding metadata transactions. Its durable pending record contains:

- Operation kind and version.
- Canonical source or parent/destination.
- Whether the folder was created by this request.
- Stable id and display name to install.
- Previous registration when one existed.
- Previous and desired assignment sets.
- Start request as post-commit intent, not transaction state.

For existing folders, the coordinator writes the journal, commits registry state, commits assignments, and clears the journal. A live failure rolls both stores back; startup recovery compares the stable id and assignment sets and either completes the desired metadata or restores the recorded previous state. Session start happens only after the journal is clear. A start failure therefore preserves the configured stopped workspace.

Embedding assignments in the registry would make one-file atomicity easy but duplicate the credential store's ownership and complicate revocation. Chaining current route calls without a journal was rejected because a crash can leave a registered workspace with only some selected assignments.

### 5. Treat newly created filesystem content as a separate commit boundary

Create new uses the folder manager's visible-segment validation and shared hierarchy reservation. It atomically creates an unused child, runs `git init`, then performs the metadata transaction. It never adopts or replaces an existing entry.

Before Git initialization begins, failure can remove the still-empty directory with non-recursive `rmdir`. Once Git initialization has written content, metadata failure rolls back Hub metadata but retains the new repository and reports its path for retry. The Hub does not recursively delete `.git` because an external process may have added content and ownership cannot be proven after the fact. A retry through Existing folder completes registration.

Creating and initializing after metadata commit was rejected because registry entries must not transiently point to missing directories. Recursive cleanup was rejected because it weakens the folder manager's deletion guarantees.

### 6. Store the default parent in a small Hub preferences store

Add a versioned `hub-preferences.json` under the canonical Hub state directory, written atomically with owner-only permissions. Its first field is optional `defaultWorkspaceParent`. Settings updates validate an absolute direct non-symlink directory and persist its canonical path.

Read APIs return both configured and effective values plus an availability state. If the configured directory is unavailable, the effective value is `os.homedir()` while the saved value remains visible for repair. Clearing removes the configured value. Browse requests with no explicit path use the effective default.

Putting this in the daemon configuration file was rejected because browser Settings cannot safely rewrite operator-managed config and supervised deployments may mount it read-only. Making it per-user was rejected because all authenticated users share one filesystem and current Hub settings/catalog semantics.

### 7. Resolve credential choices before registration

The configuration form fetches the public credential catalog once and filters authentication choices by detected Git remote transport/host when available; signing choices use declared signing capability. The request carries credential ids and authentication host selection, never secret material. Locked credentials may be assigned while stopped, but Add and start must use the existing masked unlock flow before startup.

Clone identity and retained workspace identity are distinct fields. Selecting a clone identity makes the corresponding credential available in the retained-authentication control but never fills it in automatically — an untouched control retains nothing, so only an explicit selection persists. Signing is independent. This avoids turning one-time clone access into a durable workspace grant.

### 8. Make row actions lifecycle-aware and nouns explicit

Directory listings include registration display name and live lifecycle state. Unregistered rows show Add workspace. Registered stopped rows show Start. Running rows show Open. Workspace menus use Rename workspace and Remove from Hub; directory actions use Rename folder and Remove folder. Rename workspace is available while running because it has no session or filesystem side effect.

The stopped session page gains Start and Configure actions instead of only linking back to the dashboard. Duplicate display names always show path detail. This removes the current dead end where Open navigates to a known stopped URL.

## Risks / Trade-offs

- [Two names can still confuse users] -> Label the stable value `URL ID`, hide it from primary rows, and use explicit Rename workspace versus Rename folder wording.
- [Registry migration changes a durable file] -> Default deterministically from basename, preserve ids and paths byte-for-byte, write through the existing serialized atomic mutation path, and test old-file reload.
- [Onboarding spans registry and credential stores] -> Use one bounded versioned journal, deterministic recovery, and failure injection at every commit boundary.
- [New repository initialization can leave a folder after metadata failure] -> Never recursively delete it; report that the repository was created and offer retry through Existing folder.
- [The default parent looks like a security root] -> Describe it as the initial location, keep navigation unrestricted, and test registration outside it.
- [Stopped-by-default adds one click for users who always want immediate entry] -> Keep Add and start visible as a secondary action while preserving configuration review.
- [Hub API revision increase requires coordinated clients] -> Update OpenAPI, changelog, compatibility metadata, integration fixtures, and the macOS decoder together.
- [Display-name edits do not change the child document title] -> Keep this distinction deliberate; the Hub name identifies a registration while the child title identifies watched document roots.

## Migration Plan

1. Add tolerant registry loading that derives missing display names, then persist the migrated snapshot before exposing the new API revision.
2. Add the preferences and onboarding journals with startup recovery before enabling mutation routes.
3. Deploy the new API schemas, revised Hub state, macOS decoder, and bundled UI together with the Hub API revision and changelog update.
4. Keep the legacy registration operation adapting to the new coordinator with its old start behavior.
5. Rollback is safe only to a version whose registry loader ignores the additive `displayName` field. Pending onboarding journals MUST be recovered and cleared before downgrading because older versions do not understand them.
