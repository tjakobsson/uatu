# Changelog

Notable user-facing changes to uatu are documented here. Versions follow
[Semantic Versioning](https://semver.org/) and are generated from Conventional
Commits by [Release Please](https://github.com/googleapis/release-please).

## [0.8.0](https://github.com/tjakobsson/uatu/compare/v0.7.0...v0.8.0) (2026-09-26)


### ⚠ BREAKING CHANGES

* **chat:** workspace API revision 21. ConversationStatus gains `scheduled`, a `scheduled_wakeup` item joins the ConversationItem union, and `user_message` gains optional `origin` and `wakeupId`.
* **chat:** itemize an OpenCode conversation's cost as a receipt by agent, type, or model
* **chat:** workspace API revision 20. A task `tool` item's `usage` is now that task's own spend rather than the child session's aggregate with its descendants; `tool` items gain `descendants` and `assistant_message` usage carriers gain `agent`. Both objects are closed; see `api/CHANGELOG.md` for migration.
* **chat:** Workspace API revision 19 adds optional provider-reported completedAt fields to closed tool and command item schemas. Strict workspace consumers must regenerate; Hub API revision remains 5.
* **chat:** TokenUsage is a closed wire object; the optional costUsd bumps the workspace API revision 17 -> 18 (contract, OpenAPI, runtime constant, changelog with migration).

### Features

* **chat:** add shell scrollback and a floating output window ([#372](https://github.com/tjakobsson/uatu/issues/372)) ([b206104](https://github.com/tjakobsson/uatu/commit/b20610428552de3a0b848908e3dd5e391b8b5e25))
* **chat:** itemize an OpenCode conversation's cost as a receipt by agent, type, or model ([29e347f](https://github.com/tjakobsson/uatu/commit/29e347fd85a185c612d1ad1b81fd2131cabfc02c))
* **chat:** keep Claude Code scheduled wakeups alive, shown, and cancellable ([#449](https://github.com/tjakobsson/uatu/issues/449)) ([cb56708](https://github.com/tjakobsson/uatu/commit/cb56708590fb48bb913204700bd0080de3252e01))
* **chat:** report OpenCode conversation cost per agent; render shell output as terminal text ([#368](https://github.com/tjakobsson/uatu/issues/368)) ([aba2428](https://github.com/tjakobsson/uatu/commit/aba24282879d1771101575a5a8df70be1c3ce235))
* **chat:** serve OpenCode 1.x and 2.x servers ([#430](https://github.com/tjakobsson/uatu/issues/430)) ([156ccb2](https://github.com/tjakobsson/uatu/commit/156ccb224b0bad6441fbc1cd85bbe44fb6806fdd))
* **chat:** surface working, finished, and inspectable background work across workspaces ([#425](https://github.com/tjakobsson/uatu/issues/425)) ([dec65af](https://github.com/tjakobsson/uatu/commit/dec65afa014ee55f8c555029cae14fa9c30f68b8))
* **hub:** name the session cookie for the request's port ([#375](https://github.com/tjakobsson/uatu/issues/375)) ([56e05cf](https://github.com/tjakobsson/uatu/commit/56e05cf598c255bd63652a40e449c02f06cf6591))
* **notifications:** cover all workspaces as a standing per-device rule ([bdf9f97](https://github.com/tjakobsson/uatu/commit/bdf9f9734841d1698872b8fdc8a0e7adad3c38a1)), closes [#407](https://github.com/tjakobsson/uatu/issues/407)
* **notifications:** hold pushes while you're looking at Uatu ([#455](https://github.com/tjakobsson/uatu/issues/455)) ([b087f07](https://github.com/tjakobsson/uatu/commit/b087f073efc46cfd7684a36f784e09ac94707cf2))
* **pwa:** add Web Push notifications for agent questions and turn completion ([#400](https://github.com/tjakobsson/uatu/issues/400)) ([bd40e43](https://github.com/tjakobsson/uatu/commit/bd40e43c059a44bfe4d5559c73a23e19ec7f25ff))
* **worktrees:** provider-neutral Git worktree workspaces ([#395](https://github.com/tjakobsson/uatu/issues/395)) ([89ddbec](https://github.com/tjakobsson/uatu/commit/89ddbecca61c8a86e1585aacbfdac6bfb9883966))


### Bug Fixes

* **chat:** date the timeline, picker, and reset warnings; wrap slash descriptions ([#454](https://github.com/tjakobsson/uatu/issues/454)) ([53faffb](https://github.com/tjakobsson/uatu/commit/53faffbe4a7b6e27159073e3a5b54f9c5d9e13fb)), closes [#429](https://github.com/tjakobsson/uatu/issues/429) [#427](https://github.com/tjakobsson/uatu/issues/427) [#424](https://github.com/tjakobsson/uatu/issues/424)
* **chat:** keep mobile answers visible across keyboard and lifecycle changes ([#415](https://github.com/tjakobsson/uatu/issues/415)) ([7287ac0](https://github.com/tjakobsson/uatu/commit/7287ac0443429eb8977c97ea4debd03e2826edb4))
* **chat:** read Claude Code plan usage on demand and keep the last-known report ([#397](https://github.com/tjakobsson/uatu/issues/397)) ([8606b45](https://github.com/tjakobsson/uatu/commit/8606b4506bd9165e570ad4a727d4679c677715de)), closes [#387](https://github.com/tjakobsson/uatu/issues/387) [#389](https://github.com/tjakobsson/uatu/issues/389)
* **chat:** restore saved chats correctly after workspace startup ([#378](https://github.com/tjakobsson/uatu/issues/378)) ([1501888](https://github.com/tjakobsson/uatu/commit/15018888a6dad4fa7de50af45941b96e8b6129e1))
* **chat:** state each task's own tokens on a subagent's rows when the subagent is given several tasks ([29e347f](https://github.com/tjakobsson/uatu/commit/29e347fd85a185c612d1ad1b81fd2131cabfc02c))
* **hub:** read Stopped and start in place when the viewed workspace is stopped ([#412](https://github.com/tjakobsson/uatu/issues/412)) ([8e046f6](https://github.com/tjakobsson/uatu/commit/8e046f6424e575abd9f0066290e188a4975fff7a))
* **pwa:** give Home Screen icons opaque backgrounds and maskable-safe padding ([#400](https://github.com/tjakobsson/uatu/issues/400)) ([bd40e43](https://github.com/tjakobsson/uatu/commit/bd40e43c059a44bfe4d5559c73a23e19ec7f25ff))
* **pwa:** keep iPad desktop mode inside the safe area and visible viewport ([#400](https://github.com/tjakobsson/uatu/issues/400)) ([bd40e43](https://github.com/tjakobsson/uatu/commit/bd40e43c059a44bfe4d5559c73a23e19ec7f25ff))
* **sidebar:** preserve folder state across refreshes and close the document on ancestor collapse ([04b69d1](https://github.com/tjakobsson/uatu/commit/04b69d1c891b6353552b1e79a40f00594fff74e0))
* **terminal:** keep terminals through workspace navigation via the hub ([#420](https://github.com/tjakobsson/uatu/issues/420)) ([94a7d0e](https://github.com/tjakobsson/uatu/commit/94a7d0ed465eef5ed0c18c2b1690ddd84390f517))

## [0.7.0](https://github.com/tjakobsson/uatu/compare/v0.6.2...v0.7.0) (2026-09-13)


### ⚠ BREAKING CHANGES

* **hub:** `uatu serve` and `uatu watch` are no longer user commands; a user-shaped invocation prints the Hub bootstrap steps and exits non-zero (run `uatu hub` and add folders from its dashboard). The Hub answers `/s/{id}/api/events`, `/s/{id}/api/chat/conversations/events`, and `/s/{id}/api/chat/conversations/{id}/events` with 410, naming `/api/hub/live` as the replacement, and the proxied workspace API left the public contract.

### Features

* **chat:** add Claude Code as a first-class chat agent ([#317](https://github.com/tjakobsson/uatu/issues/317)) ([30fd9c9](https://github.com/tjakobsson/uatu/commit/30fd9c9bbfdce9ba8f32c8a3f219fd84e7e7cdd6))
* **chat:** collapse the live activity tail behind a working line ([778dd69](https://github.com/tjakobsson/uatu/commit/778dd690145e92e847e0490a1db5974ddcbb6099))
* **chat:** confirm "Allow always" and show the agent's approval scope ([#352](https://github.com/tjakobsson/uatu/issues/352)) ([4fff180](https://github.com/tjakobsson/uatu/commit/4fff18054307d1031845003ea5e92595fb09743b))
* **chat:** improve OpenCode interactions ([#312](https://github.com/tjakobsson/uatu/issues/312)) ([3270288](https://github.com/tjakobsson/uatu/commit/3270288db19babeff40cba5138c56c777ba0bc96))
* **chat:** plain-words plan usage with a detail readout and a Usage pane ([65adf58](https://github.com/tjakobsson/uatu/commit/65adf58670d701641b988a5ef81a8ab9f6ece83f))
* **chat:** polish Claude Code chat, phase 1 ([#325](https://github.com/tjakobsson/uatu/issues/325)) ([e7a02e8](https://github.com/tjakobsson/uatu/commit/e7a02e8dc3de37ad7a86c4e87c40769ae8ca408e))
* **chat:** polish Claude Code chat, phase 2 ([#326](https://github.com/tjakobsson/uatu/issues/326)) ([d53fd76](https://github.com/tjakobsson/uatu/commit/d53fd769c15fa1d64ba802ad9444e7e38a9a6745))
* **chat:** polish Claude Code chat, phase 3 ([#328](https://github.com/tjakobsson/uatu/issues/328)) ([17263f7](https://github.com/tjakobsson/uatu/commit/17263f75b1223026f13db1824916fc7292fe1a40))
* **hub:** one brokered live stream per page; remove public uatu serve ([#357](https://github.com/tjakobsson/uatu/issues/357)) ([91b204d](https://github.com/tjakobsson/uatu/commit/91b204d0f242ae34c367d6e0b37d5ce727998642))
* **shell:** recover the live connection after a backgrounded page ([#365](https://github.com/tjakobsson/uatu/issues/365)) ([e5701a0](https://github.com/tjakobsson/uatu/commit/e5701a0219bd4fb3606761e82850bd015266a5be))


### Bug Fixes

* **chat:** keep small upward scrolls and land sends at the end of the timeline ([#345](https://github.com/tjakobsson/uatu/issues/345)) ([59fd26d](https://github.com/tjakobsson/uatu/commit/59fd26d3ad626da4206b9e43ce2758123d6faa05))
* **chat:** open a conversation's event stream at once instead of after the first keepalive ([#350](https://github.com/tjakobsson/uatu/issues/350)) ([4141501](https://github.com/tjakobsson/uatu/commit/414150184933f07c06af0e78ded7e252f7260099))
* **live:** keep document and Chat streams alive across mobile interruptions ([#334](https://github.com/tjakobsson/uatu/issues/334)) ([711faad](https://github.com/tjakobsson/uatu/commit/711faad09283a183a598398b0bed862a3c909f00))
* preserve manual file selection during background updates ([#341](https://github.com/tjakobsson/uatu/issues/341)) ([b3bfef3](https://github.com/tjakobsson/uatu/commit/b3bfef34053660eb2367bfda13e4132d40508711))


### Performance

* **chat:** reduce retained transcript reveal and history read work ([#342](https://github.com/tjakobsson/uatu/issues/342)) ([c11823b](https://github.com/tjakobsson/uatu/commit/c11823bbe4e38b2afddb8080b37afdf65e942774))

## [0.6.2](https://github.com/tjakobsson/uatu/compare/v0.6.1...v0.6.2) (2026-08-28)


### Bug Fixes

* **hub:** recover SSH guardian after Linux restart ([#306](https://github.com/tjakobsson/uatu/issues/306)) ([7150fcf](https://github.com/tjakobsson/uatu/commit/7150fcf8c91a4cee27260f2efc450686ee2633b1))

## [0.6.1](https://github.com/tjakobsson/uatu/compare/v0.6.0...v0.6.1) (2026-08-24)


### Bug Fixes

* **chat:** keep conversation inventory synchronized ([4020179](https://github.com/tjakobsson/uatu/commit/40201798b11584e1fe22f6f4666e3553b1825427))

## [0.6.0](https://github.com/tjakobsson/uatu/compare/v0.5.1...v0.6.0) (2026-08-24)


### ⚠ BREAKING CHANGES

* **hub:** Hub workspace sessions and clone jobs no longer inherit ambient SSH agents, Git credential helpers, GnuPG homes, or provider tokens. Operators must configure and assign Hub credentials for unattended authentication and signing. The Hub API revision increases from 1 to 4.
* **chat:** Strict workspace API consumers must regenerate against revision 6 or widen their schemas for conversation configuration, configuration events, conversation updates, and rename support.

### Features

* **api:** publish the API contract and documentation site ([373c938](https://github.com/tjakobsson/uatu/commit/373c9380d18d58f50a275df428ffd3bffc95ff2a))
* **chat:** add integrated OpenCode workspace chat ([8410b08](https://github.com/tjakobsson/uatu/commit/8410b0804236802d7c83dc9f235c3f36a5d179b8))
* **chat:** attach images to prompts from the composer ([#290](https://github.com/tjakobsson/uatu/issues/290)) ([5d8d96b](https://github.com/tjakobsson/uatu/commit/5d8d96b3a665a351c22815abdd266bee3e0b5444))
* **hub:** configure named workspaces before first start ([#292](https://github.com/tjakobsson/uatu/issues/292)) ([ced78e9](https://github.com/tjakobsson/uatu/commit/ced78e9196109b6a1b57a98dcd4659b4dff5e3c7))
* **hub:** manage folders from directory browser ([#291](https://github.com/tjakobsson/uatu/issues/291)) ([046066c](https://github.com/tjakobsson/uatu/commit/046066c31c480ad3e4f5765531c5a2d7ab9cc731))
* **hub:** manage workspace credentials ([047641f](https://github.com/tjakobsson/uatu/commit/047641f9daefa8df56f19bd00df5c84102eb5721))


### Bug Fixes

* **hub:** keep slow workspace starts alive past the startup window ([#293](https://github.com/tjakobsson/uatu/issues/293)) ([e4bee82](https://github.com/tjakobsson/uatu/commit/e4bee82758625e5ccc2360f5b109a7a129680f86))
* **watch:** keep active document previews current ([0ddd532](https://github.com/tjakobsson/uatu/commit/0ddd5328446cc87e9201010fd670f1311617dc82))

## [0.5.1](https://github.com/tjakobsson/uatu/compare/v0.5.0...v0.5.1) (2026-08-13)


### Bug Fixes

* **hub:** capture interactive clone prompts ([5fbc587](https://github.com/tjakobsson/uatu/commit/5fbc5870d20fe80f6b0c7a5485469d66488df547))

## [0.5.0](https://github.com/tjakobsson/uatu/compare/v0.4.0...v0.5.0) (2026-08-12)


### ⚠ BREAKING CHANGES

* **config:** reduce .uatu.json to a single ignore block ([#215](https://github.com/tjakobsson/uatu/issues/215))
* **overview:** remove the review-burden score and the .uatu.json review block ([#212](https://github.com/tjakobsson/uatu/issues/212))

### Features

* **cli:** deprecate public `uatu serve` in favor of `uatu hub` (one stderr line; behavior unchanged) ([6bc345c](https://github.com/tjakobsson/uatu/commit/6bc345c2b54ec0260ef7e2dd3094e588d69c2cb0))
* **config:** reduce .uatu.json to a single ignore block ([#215](https://github.com/tjakobsson/uatu/issues/215)) ([b488aee](https://github.com/tjakobsson/uatu/commit/b488aee3a64f2115e9e758c4eb11cc34c498df19))
* **desktop:** make UatuCode Desktop a connect-only hub client — add hubs by URL, including http://localhost, and sign in once ([6bc345c](https://github.com/tjakobsson/uatu/commit/6bc345c2b54ec0260ef7e2dd3094e588d69c2cb0))
* **hub:** add workspaces from the dashboard by browsing the server's filesystem — register any absolute path, or clone a repository straight into a browsed destination ([e67d08f](https://github.com/tjakobsson/uatu/commit/e67d08f1e91dec505f1946e808f490b8a4fd4c92))
* **hub:** keep sessions in a revocable server-side store — signing out ends the session on every device at once, and the dashboard's Devices pane lists each signed-in device with per-session revoke ([6bc345c](https://github.com/tjakobsson/uatu/commit/6bc345c2b54ec0260ef7e2dd3094e588d69c2cb0))
* **hub:** persist workspace state across clients ([4d7cc34](https://github.com/tjakobsson/uatu/commit/4d7cc340eec62742301ab09b4bcc86e574cff697))
* **hub:** require a login on every interface, localhost included, and print the exact bootstrap steps when a hub starts with no users configured ([6bc345c](https://github.com/tjakobsson/uatu/commit/6bc345c2b54ec0260ef7e2dd3094e588d69c2cb0))
* **hub:** self-hostable session hub with remote access and base-path serving ([#162](https://github.com/tjakobsson/uatu/issues/162)) ([6e3b155](https://github.com/tjakobsson/uatu/commit/6e3b1551d494931d81f3f43b05af7ed913dd1d0c))
* **mermaid:** operate the fullscreen diagram viewer by touch ([1afc4c2](https://github.com/tjakobsson/uatu/commit/1afc4c22b7746b313d5fdd9917ab9350efc00239))
* **mobile:** make phones and iPads first-class surfaces ([#176](https://github.com/tjakobsson/uatu/issues/176)) ([cb778fd](https://github.com/tjakobsson/uatu/commit/cb778fd53604ac0ecefbcd3c5b6893410903097c))
* **mobile:** navigate touch devices with a bottom tab bar ([574b75b](https://github.com/tjakobsson/uatu/commit/574b75b5344d036ea805379839aca7b07b24677a))
* **overview:** remove the review-burden score and the .uatu.json review block ([#212](https://github.com/tjakobsson/uatu/issues/212)) ([73bdd6e](https://github.com/tjakobsson/uatu/commit/73bdd6ebe3578d1775eaa3d36a79c0d5e88dbc2d))
* **preview:** choose the outline presentation by available width ([#232](https://github.com/tjakobsson/uatu/issues/232)) ([861770d](https://github.com/tjakobsson/uatu/commit/861770d6289426a8378279ce95dfe8d3291a016f))
* **pwa:** make the hub the installable web app and drop the service worker ([#208](https://github.com/tjakobsson/uatu/issues/208)) ([49f07ca](https://github.com/tjakobsson/uatu/commit/49f07ca54c199bf1f7c5d849fe94a3b4a0f00c22))
* **release:** publish the uatu CLI on the nightly edge channel ([#165](https://github.com/tjakobsson/uatu/issues/165)) ([aeeebef](https://github.com/tjakobsson/uatu/commit/aeeebef13cd260df5f5c8da4c3b3b9a59bb820ef))
* **server:** cap watch-refresh deferral at 2s under sustained churn ([#210](https://github.com/tjakobsson/uatu/issues/210)) ([ba8be9c](https://github.com/tjakobsson/uatu/commit/ba8be9c6d1bd5223853c0cd6388ad13a16974719))
* **shell:** reload the web client once when its build no longer matches the server, and surface a persistent notice when the mismatch survives the reload ([289d867](https://github.com/tjakobsson/uatu/commit/289d86797e34a0bc602aaba49fdb8c71686139b5))
* **terminal:** auto-attach detached sessions and add a touch terminal switcher ([a084d20](https://github.com/tjakobsson/uatu/commit/a084d20a17acf03128fc2b58ca036c26fa50220c))


### Bug Fixes

* **deps:** patch a DOMPurify XSS in detached subtrees (GHSA-55q2-fjhq-7xh7) by raising the bundled copy from 3.4.12 to 3.4.13 ([801b23c](https://github.com/tjakobsson/uatu/commit/801b23c20e62bee2b6b6ad7d852fcde2b7df0f39))
* **deps:** update Mermaid to address four moderate security advisories ([574b75b](https://github.com/tjakobsson/uatu/commit/574b75b5344d036ea805379839aca7b07b24677a))
* **mermaid:** render every diagram in narrow windows and touch mode, not only the first screenful ([1afc4c2](https://github.com/tjakobsson/uatu/commit/1afc4c22b7746b313d5fdd9917ab9350efc00239))
* **server:** serve HTML entry points with no-cache and bundle assets as content-hashed immutable, so a hard refresh can never resurrect a stale UI from browser cache ([289d867](https://github.com/tjakobsson/uatu/commit/289d86797e34a0bc602aaba49fdb8c71686139b5))
* **shell:** re-establish the live-update stream after a server restart instead of sitting on "Reconnecting" forever ([289d867](https://github.com/tjakobsson/uatu/commit/289d86797e34a0bc602aaba49fdb8c71686139b5))

## [0.4.0](https://github.com/tjakobsson/uatu/compare/v0.3.0...v0.4.0) (2026-08-01)


### Features

* **desktop:** offer git init when opening a non-git folder ([#143](https://github.com/tjakobsson/uatu/issues/143)) ([00d0072](https://github.com/tjakobsson/uatu/commit/00d00721ca03c7a10622f0ab2e269ce95ef4719e))
* **find:** in-document find (⌘F) and project search (⇧⌘F) ([9d036c3](https://github.com/tjakobsson/uatu/commit/9d036c383b2c042ba85ab082f95368a8cff48ac7))


### Bug Fixes

* **deps:** update dependency @pierre/diffs to v1.3.1 ([#148](https://github.com/tjakobsson/uatu/issues/148)) ([50105e7](https://github.com/tjakobsson/uatu/commit/50105e7dc7df6848831acaac478fd8c99d132338))
* **desktop:** restore titlebar dragging and clean the dock-right terminal strip ([#147](https://github.com/tjakobsson/uatu/issues/147)) ([167870e](https://github.com/tjakobsson/uatu/commit/167870e501ecff784c9721d928810584b60d73bc))

## [0.3.0](https://github.com/tjakobsson/uatu/compare/v0.2.0...v0.3.0) (2026-07-19)


### Features

* **ci:** nightly desktop edge channel for dogfooding main ([#132](https://github.com/tjakobsson/uatu/issues/132)) ([e1b757c](https://github.com/tjakobsson/uatu/commit/e1b757cd5bf20b4c6334937010a51b8650de3843))
* **desktop:** add native macOS tab commands ([#127](https://github.com/tjakobsson/uatu/issues/127)) ([2507210](https://github.com/tjakobsson/uatu/commit/2507210df801f89a86f4ddeaead045830c74ec67))
* **desktop:** add shared page zoom and pinch zoom ([#134](https://github.com/tjakobsson/uatu/issues/134)) ([696d209](https://github.com/tjakobsson/uatu/commit/696d20934e371bde99d90405df0baff8e6dcf288))
* **desktop:** follow the system color scheme and adopt a glass titlebar ([#137](https://github.com/tjakobsson/uatu/issues/137)) ([118d3e3](https://github.com/tjakobsson/uatu/commit/118d3e30064aa1653b21181085f237ba15d39bf8))
* **desktop:** in-app split browser with tabs for external links ([#131](https://github.com/tjakobsson/uatu/issues/131)) ([cbfa11c](https://github.com/tjakobsson/uatu/commit/cbfa11c79fa02e0c333adb46952baa4f9f4bd570))

## [0.2.0](https://github.com/tjakobsson/uatu/compare/v0.1.1...v0.2.0) (2026-07-15)


### Features

* **desktop:** add UatuCode Desktop macOS wrapper and release pipeline ([#123](https://github.com/tjakobsson/uatu/issues/123)) ([7a81b9b](https://github.com/tjakobsson/uatu/commit/7a81b9b4ba2743c4b10cbc92505b706091adac8e))
* **preview:** add file facts strip to Source and Diff views ([#117](https://github.com/tjakobsson/uatu/issues/117)) ([f92aa32](https://github.com/tjakobsson/uatu/commit/f92aa32bf3759aa1f6f40f32be8e250b7f336f98))
* **preview:** show file facts in rendered view ([#121](https://github.com/tjakobsson/uatu/issues/121)) ([1a8ea85](https://github.com/tjakobsson/uatu/commit/1a8ea8518805efb750c342fbbf39a6091bb3b264))

## [0.1.1](https://github.com/tjakobsson/uatu/compare/v0.1.0...v0.1.1) (2026-07-11)

### Bug Fixes

- Wrap long configured base refs inside the review-burden meter
  ([#100](https://github.com/tjakobsson/uatu/issues/100),
  [#114](https://github.com/tjakobsson/uatu/pull/114)).

## [0.1.0](https://github.com/tjakobsson/uatu/releases/tag/v0.1.0) (2026-07-07)

Initial public release.

### Features

- Local Markdown, AsciiDoc, Mermaid, source, and diff previews with live reload.
- Git-aware document tree, review-burden scoring, commit context, and follow mode.
- Embedded persistent terminal sessions and installable PWA support.
- Cross-platform macOS and Linux binaries with checksums, build attestations,
  and Homebrew distribution.
