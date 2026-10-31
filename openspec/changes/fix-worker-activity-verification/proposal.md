# Proposal

## Why

Fresh, uniquely owned OpenCode workers can be rejected when their child is created during launch or their first execution starts after the launcher returns. Activity presentation also inherits Stop-authorization uncertainty, making active work look unverified and unobservable work look indefinitely running.

## What Changes

- Correct first-child birth/start association with permanent public-provider regressions, without clearing genuine revocations or weakening exact-occurrence Stop checks.
- Represent current activity, occurrence confidence, terminal outcome and Stop authorization separately. Historical running metadata, shared child identity and aggregate session outcomes remain insufficient task proof.
- Use **Working / Unresolved / Finished** counts and truthful row labels: **Checking status…**, **Needs your answer**, **Session active · task unverified**, **Status unavailable · last seen …**, and **Ended · result unavailable**. Stop unavailable reasons belong in accessible task details.
- Keep unavailable and ended-without-result rows non-animated with non-growing execution timers. Recovery is automatic and bounded; introduce no manual Check again control.
- Permit presentation-only dismissal of unresolved unavailable/ended entries as well as finished history. Synchronize dismissal privately across devices for the same Hub account, stable workspace, conversation and execution. Verified activity resurfaces; new executions never inherit old dismissal. No Restore interface.
- Preserve main-session permission/question cards, identities, notifications and answering flow; linked worker rows show the existing blocking request without creating another request.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: first-launch verification, independent activity/control evidence, worker groups and labels, automatic recovery, blocking-request linkage, accessible explanations and presentation-only dismissal.
- `personal-workspace-state`: private, durable per-account worker dismissals with cross-device invalidation and execution-scoped identity, separate from navigation and geometry preferences.
- `hub-live-stream`: account-private personal-state invalidation on the existing single live connection, outside shared child-topic fanout.

## Impact

- Provider correlation/control seams in `src/chat/opencode/v2/background.ts` and `provider.ts`; normalized task/request DTOs, adapter/recovery and workspace activity aggregation.
- Shared worker state/counts, compact rows, task inspection, client persistence and UI tests across supported agents. Existing providers lacking new evidence must degrade conservatively.
- A dedicated Hub personal-dismissal store/API and account-scoped invalidation, reusing current authenticated identity, stable workspace IDs, origin checks and persistence patterns. Published API contracts and `docs/CHAT.md` must change with implementation.
- No provider/model defaults, authentication modes, credentials, service configuration, dependency additions or deployment changes. Locked dependencies were restored with approval and install scripts disabled; any additional install or browser download requires approval.
