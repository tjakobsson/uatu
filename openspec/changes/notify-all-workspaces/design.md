## Context

See proposal.md — Why. Today a device record is `{ workspaceIds, needsAnswer, completed, since }`, where `since[workspaceId][category]` is the cutoff stamped at enrollment after the hub has settled the feed position of every selected running workspace. Eligibility is `device[category] && workspaceIds.includes(ws) && authorized(device, ws) && createdAt >= since[ws][category]`. `refresh()` (every second and on session change) derives the observer set from every device's `workspaceIds`. Access is hub-wide: every hub user can reach every registered workspace, so "all workspaces the user can access" is exactly `registry.list()`.

The Hub API's `NotificationState.device` is a closed object (`additionalProperties: false`). The contract policy (memory: closed-schema field is breaking) means any new field there is a Hub-domain breaking change checked by `scripts/api-contract/compatibility.ts` against `origin/main`, regardless of release state. Hub 6 is unreleased; prior unreleased revisions were still bumped when broken (Hub 5 → 6 for the port-scoped cookie).

## Goals / Non-Goals

**Goals:**
- One boolean per device, `allWorkspaces`, that the hub evaluates at event time against the registry — never expanded into a list.
- No new history alerts: a workspace that appears later gets a cutoff before its feed is observed for the device.
- The explicit selection survives a round trip through All workspaces.
- Existing device records keep working unchanged.

**Non-Goals:**
- Per-user (cross-device) defaults, or a hub-wide operator default. Preferences stay per device.
- Preselecting All workspaces anywhere. It is off by default on the dashboard and in a workspace; the current-workspace preselection is unchanged.
- Any change to the child notification feed, the push worker, or the workspace API revision.

## Decisions

**Wire shape: `allWorkspaces: boolean` alongside `workspaceIds`, not a sentinel.**
`NotificationEnrollment` gains optional `allWorkspaces` (default `false`); the device object in `NotificationState` gains required `allWorkspaces`. `workspaceIds` stays required and keeps the explicit selection in both modes. Alternatives: `workspaceIds: "all"` (breaks the array type for every client), or a `{ mode, ids }` object replacing `workspaceIds` (breaks the request too, for no gain). A separate boolean is additive on the request and only the closed response object forces the revision bump.

**Hub API revision 6 → 7.** Touch `api/openapi.yaml` (`info.version` 7.20.0-experimental, `info.summary`, `x-uatu-revisions.hubApiRevision`), `api/contract.json`, `src/shared/version.ts` `HUB_API_REVISION`, and a new `## Hub 7 / Workspace 20 - Unreleased` section in `api/CHANGELOG.md` with `Compatibility: breaking (Hub)` and a Migration paragraph telling strict Hub clients to regenerate; the notification enrollment request needs no client change. Verify with the CI "Enforce compatibility" step run locally.

**The explicit list is stored as sent, in both modes.** The client sends the ticked checkboxes even while All workspaces is on; the server validates them as today and stores them, but eligibility ignores them when `allWorkspaces` is true. That is what makes "turn it off and get your old selection back" free, and it means `state()` can report both fields without a second storage field.

**Coverage is a function, not a field.** Introduce `covers(device, ws) = authorized(device, ws) && (device.allWorkspaces || device.workspaceIds.includes(ws))` and use it in `eligible`, `refresh`, and removal. The upstream source already exposes `workspaceIds()` (every registered workspace, wired from `registry.list()` in `live-source.ts`), so `refresh` and enrollment enumerate the registry through it; no new option is added. `authorized(principal)` without a workspace answers whether the login itself is still valid. `active(device)` becomes: the principal still resolves to the same user and session, and either `allWorkspaces` is on or some selected workspace exists — an all-workspaces device on a hub with zero workspaces is still active.

**Cutoffs for all-workspaces devices.** At enrollment, settle every running registered workspace (the union of `workspaces()` filtered by `isRunning`), then stamp `since` for every registered workspace exactly as per-workspace enrollment stamps its selection; the same-authorization / same-category cutoff carry-over applies. For a workspace that appears in the registry later, `refresh()` finds all-workspaces devices whose `since` lacks it and stamps `now` for each enabled category in one store mutation before the observer for that workspace is started. Events created before that stamp are history for the device. The window between registration and the stamp is at most one refresh tick (1 s) and closes immediately on the session-change refresh when the workspace is started, so an agent question that lands in it is practically impossible; the risk section records it. Alternative considered: stamping from the registry mutation path directly (registry has no change hook today; adding one for this is more surface than the tick justifies).

**Removed workspaces.** `refresh()` also drops `since` entries for workspace ids no longer registered from all-workspaces devices and discards their pending deliveries, so a re-registered workspace with the same id gets a fresh cutoff rather than an old one. Per-workspace devices keep today's behaviour (the id stays in `workspaceIds`; `authorized` fails while it is unregistered).

**Client dialog.** The fieldset gains a leading checkbox "All workspaces, including ones added later". While checked, the per-workspace checkboxes are disabled but keep their state; unchecking re-enables them. The status line after save distinguishes the modes ("Notifications are enabled for all workspaces on this device."). The dashboard and workspace hosts share this one module, so both surfaces get it.

**Store compatibility.** `NotificationStore.load()` treats a missing `allWorkspaces` as `false` (same place it upgrades the pre-release single-cutoff records). No version bump of `notifications.json`; a downgraded hub ignores the field and the device behaves as its stored explicit list, which is documented as the rollback behaviour.

## Risks / Trade-offs

- [An agent event lands between a workspace's registration and the first refresh that stamps it] → It is dropped as history for all-workspaces devices, never sent late. The window is ≤ 1 s and the session-change refresh closes it when the workspace starts; the spec states events before the hub first saw the workspace are history.
- [All-workspaces enrollment on a hub with many running workspaces settles them all] → Settles run in parallel within one 3 s bound; a stalled feed names its workspace exactly as today, and the device's previous record stays. No extra bound is introduced.
- [`refresh()` now reads the registry every second] → `registry.list()` is an in-memory array; the stamp mutation happens only when a new id appears, so the common tick stays write-free.
- [A downgraded hub would send from the stored explicit list only] → Documented in the API changelog migration note and SELF-HOSTING rollback text; no data is lost, the user re-saves after upgrading again.
- [Strict Hub API clients reject the new required field] → That is the revision bump; UatuCode Desktop does not consume this endpoint, so no in-repo client changes.

## Migration Plan

1. Land the hub/store/client/API/docs changes together in one PR with the Hub 7 revision bump.
2. Existing devices load with `allWorkspaces: false` and behave exactly as before; nothing is re-enrolled.
3. Rollback: an older binary reads `notifications.json` unchanged and treats every device as per-workspace with its stored list; retain the file, as the SELF-HOSTING rollback text already advises.
