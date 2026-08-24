# Changelog

Notable user-facing changes to uatu are documented here. Versions follow
[Semantic Versioning](https://semver.org/) and are generated from Conventional
Commits by [Release Please](https://github.com/googleapis/release-please).

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
