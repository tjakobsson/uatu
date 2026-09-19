## Why

Notification preferences are a fixed list of workspaces per device, so every workspace registered after enrollment stays silent until the user returns to the Notifications dialog on each device and ticks it. For the common case — "alert me about every workspace on this hub" — that is a chore that is easy to forget, and the silence is not discoverable: the user only finds out when an agent's question goes unanswered. GitHub issue #407.

## What Changes

- Add an **All workspaces** option to the per-device notification preferences. When it is on, the device receives its selected event categories from every workspace it can access, and workspaces registered later are covered automatically — the preference is stored as a standing rule, not expanded into the list of workspaces that existed when it was saved.
- Keep the existing per-workspace selection as the alternative for users who want only specific workspaces. The two modes are exclusive on a device; switching back to a selection preserves the workspaces that were ticked before.
- Enrolling or saving with All workspaces on waits for every running workspace's feed position the same way a per-workspace enrollment does, so post-enrollment events are never lost and history is never announced. A workspace registered later starts counting from the moment the hub first sees it registered.
- **BREAKING** (Hub API): the enrollment request gains an optional `allWorkspaces` boolean and the device state object gains a required `allWorkspaces` boolean. The device object is closed, so strict Hub clients regenerate against a bumped Hub API revision. Removing a workspace no longer requires touching all-workspaces devices; per-workspace devices behave as today.
- Update README and self-hosting docs, which currently state that newly registered workspaces are never subscribed automatically.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `web-push-notifications`: the "Device preferences select workspaces and event categories" requirement changes — a device may select all workspaces as a standing rule, and a workspace added later is covered by such devices while remaining absent from per-workspace selections. The enrollment settle rule in "Notifications require explicit device opt-in" extends to every running accessible workspace when All workspaces is on. "Delivery continues without an open page" gains the rule that the hub starts observing a newly registered workspace for all-workspaces devices without any client action.

## Impact

- `src/hub/notification-store.ts` — `NotificationPreferences` and `NotificationDevice` gain `allWorkspaces`; pre-change device records load as `allWorkspaces: false`.
- `src/hub/notifications.ts` — eligibility, `active`, `refresh` (observer set), enrollment settle, and cutoff stamping consult the mode; the coordinator enumerates the registry through the upstream source's `workspaceIds()` and stamps cutoffs for workspaces newly seen by all-workspaces devices; `authorized` in `main.ts` answers a principal-only check when no workspace is given.
- `src/pwa/notification-client.js` — the dialog gains the All workspaces control; the per-workspace checkboxes are disabled while it is on.
- `api/openapi.yaml`, `api/contract.json`, `api/CHANGELOG.md`, `src/shared/version.ts` — Hub API revision 7, `NotificationEnrollment` and `NotificationState` schema updates, changelog section with migration note.
- `README.md`, `docs/SELF-HOSTING.md` — describe the option and correct the "never subscribed automatically" sentence.
- Tests: `src/hub/notifications.test.ts` (coverage for all-workspaces eligibility, later-registered workspace cutoff, settle over every running workspace, removal, legacy record load), `tests/e2e/notifications.e2e.ts` (dialog flow and evidence screenshot), `bun run test:api` contract checks.
- No change to the push worker, the child notification feed, the workspace API, or UatuCode Desktop (which does not consume the notification API).
