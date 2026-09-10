## 1. Reference and frontend contract foundation

- [x] 1.1 Record the current dirty-tree baseline and map the retained reference images to normalized CSS viewports, states, and branding exceptions in a review-evidence index; verify that original reference files and existing user changes are not overwritten.
- [x] 1.2 Define the reusable frontend backend interface using existing credential, assignment, clone, workspace, and readiness types plus explicit branch-state values; verify type checks and colocated tests reject impossible or ambiguous operation states without importing mock fixtures into product code.
- [x] 1.3 Audit the workspace boot, URL/base-path cache, global key handlers, focus, and visibility/resize owners needed for same-document coexistence; deliver a scoped integration map and verify each required change has an identified existing owner rather than a second state singleton.
- [x] 1.4 Add the approved frontend-only explicit credential protection/lock, OpenPGP user-ID and saved tool-override facts; populate synthetic states and verify truthful current-value presentation without inferring facts from diagnostic prose or changing live/public APIs.
- [x] 1.5 Add the approved clone submission-attempt identity and authoritative reconciliation seam; verify authenticated ownership, reload hints, accepted/not-accepted/pending/expired outcomes and no duplicate submission or uncertainty loss through navigation/discard.

## 2. Isolated mocked-backend review runtime

- [x] 2.1 Add a test-only review launcher that bundles the intended product frontend and serves only approved assets/fixtures on loopback; verify health/start/stop behavior and traversal/unrelated-file rejection without starting the production Hub, credential tools, providers, or PTYs.
- [x] 2.2 Implement typed synthetic Hub reads and operations for auth, workspaces, metadata, preferences, credentials, devices, and onboarding; verify fixture reset and mutation logs affect only test-owned state and unknown requests fail rather than falling through or returning generic success.
- [x] 2.3 Supply protocol-compatible workspace corpus/render, Chat/attachment, and Terminal stream doubles for the real clients; verify the actual surface clients boot, render synthetic content, and can hold/settle a pending upload without invoking an executable shell or provider.
- [x] 2.4 Add a separate test-owned scenario controller with stable fixture clocks and pending/failure/stream controls; verify simulation warnings, no-real-credentials guidance, independent synthetic session state, and absence of review controls from the product viewport/bundle.

## 3. Reference-faithful core mobile frontend

- [x] 3.1 Create scoped mobile visual primitives for current branding, grouped surfaces, contextual icons, action capsules, docks, and bottom sheets; verify they reproduce representative reference geometry/materials and do not alter workspace or desktop styles.
- [x] 3.2 Implement the actual dashboard composition with host/count context, Running/Ready to start groups, folder/branch/ellipsis rows, Open/Start, workspace information, and Add Workspace; verify visual/structural assertions catch the previous text-only icons and generic panel hierarchy, including long/duplicate names and branch variants.
- [x] 3.3 Implement the grouped Settings identity/credential/workspace/account overview with focused destination views rather than inline administrative forms; verify it matches the reference screen composition and all screen-map destinations are reachable.
- [x] 3.4 Implement Hub/Settings icon-and-label docks and distinct two-line Return presentation using validated stable workspace identity; verify fresh/visited/renamed/duplicate/stopped/missing cases and management of B never retargets A.
- [x] 3.5 Implement the Preview-side, handle-placement, and navigation-dismissal sheets against the existing preference owner; verify current-value initialization, draft/Cancel/Done behavior, keyboard/backdrop focus handling, storage fallback, and no semantic preference leakage.

## 4. Same-document continuity vertical slice

- [x] 4.1 Assemble scoped Hub and existing workspace roots with one workspace boot and no iframe; verify dashboard -> workspace -> Hub -> Settings -> Preview-side sheet -> Return keeps the same workspace/client sentinel on all four surfaces and does not force Preview.
- [x] 4.2 Partition canonical Hub/detail and workspace history dispatch while keeping workspace service base path fixed; verify Back/Forward, direct route load, file/hash/commit-query restoration, Hub scroll, and no history-induced Start or false document selection.
- [x] 4.3 Gate inactive-root shortcuts, focus, pointer handling, and visible navigation through their existing owners without disposing background work; verify typing in Hub forms does not reach Terminal or hidden find/chat handlers, and hidden-root geometry does not reset terminal sizing or scroll.
- [x] 4.4 Preserve exact pending Chat File/draft ownership, synthetic upload progress, Chat stream state, and the real terminal client across Hub detours; verify one request/transport and continuing output, not reconstructed filenames or a fake surface.
- [x] 4.5 Implement foreground invalidation and stale-response generation guards for synthetic 401/revoke/sign-out/Stop/removal; verify protected retained content cannot reappear, stopped history remains truthful, and desktop/standalone entry and live mode escape remain unchanged.

## 5. Complete mobile flows and reviewed extensions

- [x] 5.1 Implement login, identity, loading/empty/unavailable views and contextual retry using the reference grammar; verify no unauthenticated workspace/version disclosure and representative light/dark/keyboard states are included in the review evidence.
- [x] 5.2 Implement credential catalog, chooser, SSH detail and applicable generate/import/public/unlock/lock/enable/disable/test/delete sheets; verify mocked intent sequences, masking/clearing, import-source/size validation, cancellation, and contextual failures match existing semantics.
- [x] 5.3 Extend credential details/tasks to OpenPGP and HTTPS/provider tokens plus tool-readiness/override views; verify only supported operations are offered, missing/incompatible tooling is actionable, and stored secrets never reappear.
- [x] 5.4 Implement workspace assignment/default editors and default-folder flow in grouped detail/sheets; verify current versus assign-new intent, separate auth/signing and host scope, no-op edits, review/back drafts, stop-dependency cancellation/failure, and fallback explanations.
- [x] 5.5 Implement workspace menus, rename/Stop/Forget states, devices, current-session revoke, security explanations and sign-out presentation; verify distinct destructive language, focus recovery, synthetic partial failures and preserved existing authorization/operation ordering.
- [x] 5.6 Implement Add Workspace, folder browse, existing-repository configuration, create/rename/remove-folder and registration flows; verify display/folder identity, explicit Git-init consent, nested-registration and collision/error states using only synthetic effects.
- [x] 5.7 Implement clone options, independent unlock recovery, streamed progress/input/cancel and each terminal/partial outcome; verify unchanged non-secret drafts, one explicitly authorized submission, any-prompt masking, retry/reconnect and truthful retained-workspace/checkout outcomes.

## 6. Workspace chrome and cohesive motion

- [x] 6.1 Align workspace selector/handle and Preview pill materials, icon strokes, spacing and state colors with the reference while preserving current interiors; verify all named expanded/collapsed/Terminal/left-right/boundary/error states in the reference contract.
- [x] 6.2 Implement the same-document workspace/Hub reveal and Return transitions with preserved scroll and interruptible input; verify no animation-driven remount or focus steal, reference selector fade behavior, and immediate reduced-motion alternatives.
- [x] 6.3 Reconcile the complete `screen-map.md` inventory with implemented routes/scenarios and classify every unpictured extension or unresolved visual deviation; verify there are no silently omitted actions, fake success placeholders, or unexplained UI exceptions.

## 7. Frontend acceptance evidence

- [ ] 7.1 Add deterministic feature-named visual regression coverage and retained reference/actual comparison evidence; verify a deliberate icon/hierarchy/material regression fails and document normalization, branding/data substitutions, comparison tolerances, and any masks instead of blessing mismatches.
- [x] 7.2 Exercise the full core and exceptional review flows in installed Chromium and WebKit at phone/tablet touch sizes, short landscape, 200% text, keyboard and reduced/contrast preferences; verify the scenario report names actual passes, failures and untested states without claiming physical-device or live-backend validation.
- [x] 7.3 Run focused unit/E2E regressions for changed workspace, navigation, form and preference owners plus type checking and production-bundle separation checks; verify no fixture/server/scenario-control imports enter shipping code and record exact commands/results.
- [ ] 7.4 Compare fine-pointer desktop/native-inset presentation and unchanged workspace interiors against pre-change evidence; verify no global CSS/event/route leakage and account explicitly for intentional overlay changes rather than deleting assertions.

## 8. Serve for user review and stop

- [x] 8.1 Launch the isolated mock review on unused loopback/Tailscale HTTPS ports and leave existing Hub/test/reference services intact; verify local readiness and remote phone access, then provide exact scoped start/stop/restart/reset commands and simulation credentials/instructions without personal secrets.
- [x] 8.2 Deliver the frontend review URL, reference/actual evidence, complete scenario guide, unpictured-state designs, known gaps, and an acceptance record marked awaiting user review; verify the handoff explicitly distinguishes mocked behavior from live backend correctness.
- [ ] 8.3 Obtain and record the user's explicit visual and interaction approval of the served frontend version and accepted exceptions. **Human gate: leave unchecked until the user approves; stop here and request review.** Passing tests cannot complete this task or authorize real backend integration, production rollout, spec sync, or archive.

Live integration tasks are deliberately not included. After frontend approval,
obtain authorization and prepare the real backend/API/routing/security task set
before continuing. Keep production-facing delta specs unmerged until their live
requirements are implemented and verified.

## 9. User-requested iOS UX and one-handed correction

- [x] 9.1 Research official Apple iOS HIG and Uatu API semantics, reproduce the folder/readiness symptoms with deterministic failing checks, and audit all 27 screen families without treating screenshot capture as UX approval.
- [x] 9.2 Implement shared lower-screen task navigation and primary-action placement with one natural home per action; verify no duplicate Back/Add/commit controls and safe dock, text and keyboard clearance.
- [x] 9.3 Replace oversized folder/action stacks with compact grouped hierarchy rows and contextual secondary commands; verify all folder/configuration/creation/error/partial-result operations remain reachable and truthful.
- [x] 9.4 Replace flat readiness/tool walls with useful outcome/blocker summaries and complete progressive diagnostics; verify explicit facts, action reachability and no invented or discarded API information.
- [x] 9.5 Reconcile workspace, credential, assignment, device, security and clone menus/forms with the same one-handed patterns; eliminate duplicate cancellation paths while preserving drafts, confirmations and asynchronous ownership.
- [ ] 9.6 Re-run the complete option/scenario and regression matrix in Chromium/WebKit with small/large/keyboard/text/accessibility cases, and retain before/after UX evidence and named limits.
- [x] 9.7 Update the versioned handoff and approval record, refresh only the isolated review candidate, verify it, and stop for renewed user visual/interaction review without live integration.

## 10. Settings convention refinement and workspace cold entry

- [x] 10.1 Restore conventional iOS Settings navigation/contextual editing, remove blanket bottom commands and single-option menus, clarify Hub-wide folder behavior, and preserve draft/Cancel/Save semantics without duplicated controls.
- [x] 10.2 Present credential purpose and understandable local availability first, explain secondary troubleshooting and each tool's role, retain all diagnostics, and preserve capability/secret/operation semantics.
- [x] 10.3 Reproduce and repair cold-entry handle/selector presentation, provide loading Back to Hub, fence inactive shortcuts and late boot completion, and preserve saved Files/placement/URL and first-frame Hub availability.
- [ ] 10.4 Complete current Chromium/WebKit integration, responsive and cold-entry verification; retain exact test results and keep blocked checks open rather than inheriting an older green matrix.
- [x] 10.5 Publish the versioned isolated review refinement with its evidence and outstanding verification clearly identified, then request renewed user review without live integration.

## 11. Direct Settings and full-page editors

- [x] 11.1 Replace drawer task presentation with one shared full-page editor/result owner and explicit centered consequential confirmations; preserve focus, cancellation, secret clearing and safe history without duplicate controls.
- [x] 11.2 Expose applicable Settings/management actions directly, remove generic More menus and option accordions, keep folder rows compact, and preserve every supported operation and confirmation order.
- [x] 11.3 Remove diagnostic panels from normal Settings; provide concise explicitly requested check results and a complete named report view, with readable long metadata values and no repeated check on report Back.
- [ ] 11.4 Complete current cross-engine editor/confirmation/history/operation/continuity verification and current visual evidence; keep failed or blocked checks explicit rather than inheriting older passes.
- [x] 11.5 Publish the isolated page-based candidate and updated evidence/acceptance record, then stop for user review without live integration.

### Reconciliation checkpoint — 2026-09-10

**31/36 complete; 7.1, 7.4, 8.1, 8.2, 8.3 remain pending.** See
`review-evidence/progress.md` for scoped commands/results and
`review-evidence/scenario-guide.md` for complete screen/scenario coverage and
unaccepted UI exceptions. Reference/measured regression guards do not complete
approved pixel-golden comparison (7.1); current scoped isolation does not recover
exact dirty pre-change all-four-interior proof (7.4). Candidate URLs/documents
are prepared, not remotely verified/delivered (8.1/8.2). Full final browser rerun
after cross-workspace expansion and served fingerprint await lead update.
No human visual/interaction approval or live integration authorization is implied.
