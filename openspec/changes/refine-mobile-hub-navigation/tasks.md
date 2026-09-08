## 1. Establish The Production Baseline

- [ ] 1.1 After explicit implementation approval, update the focused branch against current `main` and record the baseline commit; verify the working tree and unrelated worktrees are preserved.
- [ ] 1.2 Inventory the current Hub operations and workspace lifecycle against design.md D9; verify each matrix row maps to an existing test or a concrete new regression case before changing UI.
- [ ] 1.3 Add or reuse isolated real-Hub/workspace browser fixtures under `tests/`; verify login, two distinct workspace identities, stopped/running state, scoped documents, and all credential types can be exercised without importing `design/hub-mobile/` fixtures.
- [ ] 1.4 Record desktop and representative mobile baselines; verify the existing typecheck and relevant Hub, touch, Preview, Chat, Terminal, and API tests pass before presentation changes.

## 2. Integrate Mobile Hub Presentation

- [ ] 2.1 Introduce the touch-oriented Hub layout and minimal shared style/client helpers through existing delivery paths; verify coarse-pointer phone/tablet rendering, fine-pointer desktop parity, live system theme, and native titlebar clearance in browser tests.
- [ ] 2.2 Render grouped workspace lists with readable identity, real shell/credential summaries, primary Open/Start, and secondary actions; verify duplicate names, long paths, empty/error/loading states, and slow-action opening feedback against actual Hub responses.
- [ ] 2.3 Present Hub and Settings destinations with Add Workspace as an action while retaining `/clone` and sign out; verify every existing route and workflow remains reachable and native sign-out still performs the required navigation.
- [ ] 2.4 Adapt Settings summaries/details and device-session presentation without removing operations; verify actual SSH/OpenPGP/token capabilities, role/host information, tools, defaults, revocation, issue-time labels, and current-session sign-out.

## 3. Add Validated Return Navigation

- [ ] 3.1 Add a production-specific browsing-session Return hint bound to a stable workspace id and current authenticated session; verify independent fresh tabs have no fabricated hint, opener/duplicated contexts can inherit only a genuine revalidated hint, reload/Back preserve valid context, and invalid/expired/different-session records are rejected without leaking metadata.
- [ ] 3.2 Render Return first across Hub subpages after a valid visit and use existing Open/credential-aware Start behavior; verify rename, duplicate names, stopped/missing targets, no-assignment confirmation, unlock, and startup failure paths.
- [ ] 3.3 Integrate history, `pageshow`, and scroll restoration without a resident workspace host; verify manage-B-after-opening-A cannot change the return/history identity, BFCache clears stale opening state, and Back does not start or substitute a workspace.
- [ ] 3.4 Implement the bounded, non-blocking Return validator with generation/authentication invalidation; verify slow/hanging Hub state and session-list responses do not block workspace readiness or Hub actions, timeouts withhold Return, and delayed responses cannot revive hints after logout, revocation, or relogin.

## 4. Evolve Touch Workspace Navigation

- [ ] 4.1 Adapt the existing surface-navigation owner to render the overlay selector and separate conditional Hub action; verify exactly four surface tabs, no Hub affordance for standalone/arbitrary-base-path serve, and no duplicate surface instances.
- [ ] 4.2 Separate reserved inset from measured overlay bounds and remove the touch navigation gutter; verify Preview, Chat composer, Terminal visual viewport, keyboard/safe-area constraints, and desktop dock/split restoration retain their existing behavior.
- [ ] 4.3 Implement entry expansion, the seven-second idle policy, non-pointer focus protection, held-pointer release/cancel handling, Keep Open, and dismissal/focus rules; verify idle/reset/focus/pointer-leave/keyboard/hover cases, outside taps and typing reaching content exactly once, Keep Open suppression, related Preview-control stability, and higher-priority-dialog handling with controlled browser timing.
- [ ] 4.4 Implement the movable edge handle, drag/tap discrimination, directional/reset keyboard actions, and viewport clamping; verify interrupted drags, rotation, zoom, saved placement, and that terminal scrolling/text selection is not intercepted outside the handle.
- [ ] 4.5 Implement local opacity-only reveal/dismissal and the overlay-only Terminal contrast palette; verify usable controls during reveal, reversal without flashing, Reduce Motion/Transparency, and unchanged terminal styling and input behavior.
- [ ] 4.6 Relay existing Chat attention and Terminal unseen-output signals to the selector and handle; verify the surface owners remain authoritative and acknowledgement, unavailable surfaces, and hidden-pane output still work.
- [ ] 4.7 Preserve existing shortcuts and live touch/desktop mode normalization; verify active-surface Find, project Search, user-driven Preview promotion, and no surface/focus stealing from Follow Rules C/D or background activity.

## 5. Add Narrow Client Presentation Preferences

- [ ] 5.1 Implement validated production navigation keys and Hub Settings controls for placement, auto-hide, and Preview side, plus a reachable standalone configuration path; verify Hub sharing, standalone base-path isolation, corrupt/unavailable storage fallback, and no prototype-key migration.
- [ ] 5.2 Synchronize only the new preferences across same-Hub tabs and resolve remote changes during local dragging; verify workspace-local mode/geometry, semantic preferences, active tabs, and PTY attachment hints remain independently scoped.

## 6. Add Preview File Navigation

- [ ] 6.1 Implement a pure sibling-selection operation over the existing client corpus and selection identity; verify exact root/directory boundaries, dot-first/case-insensitive ordering, stable ties, mixed file kinds, duplicate paths, pins, and CLI single-file scope in colocated tests.
- [ ] 6.2 Connect Previous/Next and Back to Files through existing owner operations, not DOM adapters; verify images and reserved characters, history, Follow Rule A, unchanged filters/reveal cues, renderer modes, and preservation of Chat/Terminal resources during in-page selection.
- [ ] 6.3 Add the persistent translucent Preview overlay and side preference, using measured selector bounds; verify visibility only in touch Preview, enlarged layouts, single-file arrow hiding, clearly disabled multi-file boundaries, and non-file previews.
- [ ] 6.4 Implement explicit pending/index-error/timeout/missing-target recovery through the existing load-generation boundary; verify visible Retry, Back to Files availability, no false first/last state, exact-target revalidation, stale-response rejection, and no full-workspace reload on recovery.

## 7. Preserve Forms And Complete Workflow Parity

- [ ] 7.1 Implement stable in-page task/draft ownership across review, validation, cancellation, and state refresh; verify generic edit-default forms initialize correctly, explicit assign-new intent remains clear, unchanged forms do not replace defaults, and review cancellation restores input/focus.
- [ ] 7.2 Keep unlock recovery inside the owning start/clone flow with non-secret draft retention; verify cancelled recovery creates no work, successful continuation respects the original authorized intent, no duplicate clone/start is created, and existing secret/import clearing rules remain intact.
- [ ] 7.3 Preserve complete directory management and onboarding controls in mobile presentation; verify empty-folder creation/removal, display versus filesystem rename, nested registered-folder stopping, Git-init consent, dual credential choices, default-parent fallback, and retained-path/configured-workspace recovery.
- [ ] 7.4 Preserve real clone job progress and control presentation; verify owner-only replay/reconnect, unrecognized masked prompts, cancel, inactivity/lifetime timeout, expired jobs, all failure variants, stopped success, and successful requested start using documented API events.
- [ ] 7.5 Verify destructive and composite mobile actions against real API ordering; confirm stop-before-forget, failed-stop catalog preservation, provider-token consequences, no filesystem deletion by forget, and truthful partial outcomes with retry.

## 8. Integrate Browser And Compatibility Coverage

- [ ] 8.1 Add focused Chromium and WebKit projects/entrypoints for the production mobile paths without reducing existing suite coverage; verify 320/390 portrait, short landscape, tablet touch, desktop, light/dark, 200% text, and reduced-preference cases run against application routes rather than prototype pages.
- [ ] 8.2 Verify the full D9 lifecycle matrix, including actual multi-workspace navigation, independent clients, existing chat drafts/uploads/queues and attention, real controlled PTY attachment/reconstruction, unavailable backends, authentication/session revocation, PWA routes, and native-wrapper sign-out expectations.
- [ ] 8.3 Compare desktop and workspace-interior baselines, accounting only for the explicitly changed navigation space/overlays; verify no header/body redesign, lost control, changed default, or weakened existing assertion is hidden by a snapshot update.
- [ ] 8.4 Reconcile the documented clone-start-failure scenario with the already-current runtime/API and add or retain its regression coverage; verify no backend lifecycle or wire-contract change was introduced to satisfy the documentation correction.

## 9. Final Validation And Contribution Workflow

- [ ] 9.1 Run `bun run typecheck` and `bun audit --audit-level=moderate`; verify both pass, or resolve and document blockers before requesting final implementation review.
- [ ] 9.2 Run `bun test` and the repository's relevant API validation/contract checks, including `bun run test:api`; verify existing and new tests pass without removing coverage or changing product behavior to accommodate projected credentials.
- [ ] 9.3 Run `bun run check:licenses`, `bun run build`, and `bun run smoke`; verify the compiled application excludes all design-fixture, mock-service, and prototype dependencies.
- [ ] 9.4 Run `bun run test:e2e` plus the configured focused WebKit/mobile coverage; verify complete browser results and record the commands/configurations, without adding an iPhone/device-farm gate.
- [ ] 9.5 Update user/developer documentation for the new UI, preference scopes, Return validation, and unchanged session lifecycle; verify examples use production routes and never imply the prototype iframe or live-client guarantees were adopted.
- [ ] 9.6 Obtain a fresh implementation review covering standards, API/spec parity, accessibility, and the non-regression matrix; resolve findings and rerun affected tests before declaring implementation complete.
- [ ] 9.7 Once implementation is complete and finalization is authorized, sync delta specs and archive this change before merge; verify `bunx @fission-ai/openspec validate --all --strict` passes and task/spec/documentation state matches the delivered behavior.
- [ ] 9.8 Prepare release/review metadata following `CONTRIBUTING.md`; verify the proposed Conventional Commit classification describes the stable-to-stable user-visible delta, any unreleased-fix override is correct, and no manual version/tag/future-changelog edits occurred. Commit, PR creation, and merge remain separately authorized actions.
