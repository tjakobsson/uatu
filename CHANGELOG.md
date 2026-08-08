# Changelog

Notable user-facing changes to uatu are documented here. Versions follow
[Semantic Versioning](https://semver.org/) and are generated from Conventional
Commits by [Release Please](https://github.com/googleapis/release-please).

## [0.5.0](https://github.com/tjakobsson/uatu/compare/v0.4.0...v0.5.0) (2026-08-08)


### Features

* **desktop:** unify UatuCode Desktop on the uatu hub ([e67d08f](https://github.com/tjakobsson/uatu/commit/e67d08f1e91dec505f1946e808f490b8a4fd4c92))
* **hub:** add trusted local mode and path-based workspaces ([e67d08f](https://github.com/tjakobsson/uatu/commit/e67d08f1e91dec505f1946e808f490b8a4fd4c92))
* **hub:** persist workspace state across clients ([4d7cc34](https://github.com/tjakobsson/uatu/commit/4d7cc340eec62742301ab09b4bcc86e574cff697))
* **hub:** self-hostable session hub with remote access and base-path serving ([#162](https://github.com/tjakobsson/uatu/issues/162)) ([6e3b155](https://github.com/tjakobsson/uatu/commit/6e3b1551d494931d81f3f43b05af7ed913dd1d0c))
* **mobile:** make phones and iPads first-class surfaces ([#176](https://github.com/tjakobsson/uatu/issues/176)) ([cb778fd](https://github.com/tjakobsson/uatu/commit/cb778fd53604ac0ecefbcd3c5b6893410903097c))
* **mobile:** navigate touch devices with a bottom tab bar ([574b75b](https://github.com/tjakobsson/uatu/commit/574b75b5344d036ea805379839aca7b07b24677a))
* **release:** publish the uatu CLI on the nightly edge channel ([#165](https://github.com/tjakobsson/uatu/issues/165)) ([aeeebef](https://github.com/tjakobsson/uatu/commit/aeeebef13cd260df5f5c8da4c3b3b9a59bb820ef))


### Bug Fixes

* **deps:** update Mermaid to address four moderate security advisories ([574b75b](https://github.com/tjakobsson/uatu/commit/574b75b5344d036ea805379839aca7b07b24677a))

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
