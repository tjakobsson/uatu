# Changelog

Notable user-facing changes to uatu are documented here. Versions follow
[Semantic Versioning](https://semver.org/) and are generated from Conventional
Commits by [Release Please](https://github.com/googleapis/release-please).

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
