## Context

The embedded terminal uses `xterm.js` and reads its font via the CSS variable `--terminal-font-family` (defined in `src/styles.css`). The current stack lists Nerd Font face names (FiraCode, JetBrainsMono, Hack, MesloLGS, CaskaydiaCove) followed by generic monospace fallbacks. None of these are bundled — they only resolve if installed locally.

Two failure modes follow:

1. **No Nerd Font installed.** The user sees TOFU squares wherever the shell prompt emits a Private-Use-Area codepoint (e.g.,  `U+E0B0`,  `U+E0A0`, devicon icons in `U+E700–U+E8FF`).
2. **Safari / locked-down browser profiles.** Safari restricts which user-installed fonts a web page can read by family name (anti-fingerprinting). Even Chrome on macOS in some configurations drops this access for cross-origin contexts. The PWA version of uatu inherits the host browser's policy. Net effect: a user with `Hack Nerd Font Mono` installed still sees TOFU in Safari, because `font-family: "Hack Nerd Font Mono"` resolves to nothing the page is allowed to use.

The fix is to ship the entire face with the binary and expose it via a normal `@font-face src: url(...)` rule, which has none of the local-install restrictions.

Constraints:

- The compiled `dist/uatu` binary is already several MB (mermaid, shiki, github-markdown-css). The font addition needs to stay within a reasonable budget — target ≤ 1.5 MB on disk. (Initial estimate of 500 KB was wrong: the Nerd Font icon patch contributes ~10,000 glyphs and dominates the file regardless of base font; full Nerd Font WOFF2s land at ~1.0–1.2 MB.)
- Licensing must remain compatible with redistribution in a closed, downloadable binary. `bun run check:licenses` enforces this and currently allows MIT/BSD/ISC/Apache-2.0/0BSD/CC0-1.0/Unlicense/Python-2.0. Hack Nerd Font Mono ships under MIT + SIL OFL 1.1; the OFL half is not allowlisted yet.
- The route table is the single source of truth (`src/server/routes.ts`) and must work for both `cli.ts` (prod) and `tests/e2e/server.ts` (e2e).
- Cross-platform: per [[feedback_cross_platform]], the font must work identically on macOS, Linux, and Windows. A web font ticks that box automatically — no OS font cache invalidation, no platform-specific install instructions.

## Goals / Non-Goals

**Goals:**

- Bundle a single, small full Nerd Font in the binary and make it the terminal's default face, so terminal ASCII and prompt icons both render correctly in every browser, including Safari and the PWA, with zero user setup.
- Keep the WOFF2 file ≤ 1.5 MB on disk.
- Keep `.uatu.json terminal.fontFamily` as the override path: a user-supplied family wins over the bundled default.
- Add SIL OFL 1.1 to the license-check allowlist and ship the license text(s) with the binary's legal notices.
- Establish a `bundled-fonts` capability so future fonts have a documented place to land.

**Non-Goals:**

- Bundling multiple Nerd Font variants. One default is enough; users with strong opinions use `.uatu.json`.
- Replacing the Markdown body font (`Inter`) or the code-block font in the rendered preview. Out of scope.
- Letting users supply their own bundled font at runtime. The bundled face is fixed at build time.
- Subsetting glyphs at build time. The full Hack Nerd Font Mono WOFF2 is comfortably within budget; subsetting would add tooling without solving a real problem.

## Decisions

### Decision 1: Ship `HackNerdFontMono-Regular.woff2`

The Nerd Fonts project publishes a `Hack` patched variant that combines the Hack programming font with the full Nerd Font icon set (powerline, devicons, file icons, weather, FontAwesome subset, Material Design icons, Octicons, Codicons, Pomicons, IEC power symbols). The Mono variant forces icons to single-cell width — required in a terminal grid.

Measured WOFF2 sizes from Nerd Fonts v3.4.0 (the icon patch dominates the file in every variant):

| Candidate                                    | WOFF2 size (measured) | Coverage                                | License            |
|----------------------------------------------|-----------------------|-----------------------------------------|--------------------|
| `HackNerdFontMono-Regular.woff2` (chosen)    | 1.18 MB               | Latin + all Nerd Font icon ranges       | MIT + SIL OFL 1.1  |
| `0xProtoNerdFontMono-Regular.woff2`          | 1.00 MB               | Latin + all Nerd Font icon ranges       | SIL OFL 1.1        |
| `SymbolsNerdFontMono-Regular.woff2`          | 1.18 MB               | **Icons only** — no Latin                | SIL OFL 1.1        |

Symbols-only was eliminated because the user explicitly wants the bundled face to be the *default*, which means it has to render letters acceptably. Hack wins on the size/legibility/recognizability trade-off for a default that ships to every uatu user.

**Alternative considered:** Bundle no font and document the install steps. Rejected — Safari and the PWA can't see locally installed faces regardless of install effort, so the documentation path leaves Safari users broken forever.

### Decision 2: `@font-face` uses `local()` first, `url()` second

```css
@font-face {
  font-family: "Hack Nerd Font Mono";
  src: local("Hack Nerd Font Mono"),
       url("/assets/fonts/HackNerdFontMono-Regular.woff2") format("woff2");
  font-weight: normal;
  font-style: normal;
  font-display: block;
}
```

Reusing the upstream family name is deliberate: if a user has Hack Nerd Font Mono installed locally AND the browser allows access to it, the browser uses the local copy (zero network) and there's no duplicate-face conflict. If the local copy isn't available or the browser refuses (Safari), the browser fetches the bundled URL. This is the standard "self-hosted with local fallback" pattern.

The `--terminal-font-family` stack collapses to:

```css
--terminal-font-family: "Hack Nerd Font Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
```

Just one named face, plus generic monospace fallbacks for the worst-case "font fetch failed AND no local mono" path. This is much simpler than today's wishlist of locally-installed Nerd Fonts.

`font-display: block` is appropriate because the font is local to the binary and arrives within milliseconds on localhost; the brief blocking period prevents a FOUC of TOFU squares before the font is ready.

**Alternative considered:** Name the bundled face something unique (`"Uatu Mono"`) and prepend it in the stack. Rejected because it loses the `local()` benefit — users with the same upstream font installed would needlessly fetch the bundled copy.

### Decision 3: Serve from `/assets/fonts/<name>.woff2` via the existing `buildRoutes` factory

Add a `fonts: { hackMono: string }` field to `RouteAssets`, wire it in both `src/cli.ts` (using `with { type: "file" }`) and `tests/e2e/server.ts`. Serve via `new Response(Bun.file(path), { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" } })`. The route path is stable so `styles.css` can reference it as `url("/assets/fonts/HackNerdFontMono-Regular.woff2")`.

`immutable` is safe because the file is part of the compiled binary — it changes only on a new uatu release.

**Alternative considered:** Inline the font as a `data:` URI inside `styles.css`. Rejected — `styles.css` is served as a small text response and inlining a base64 woff2 would inflate it 33% and prevent the browser from caching the font separately from the CSS.

### Decision 4: Add SIL OFL 1.1 to `src/shared/license-check.ts` allowlist, ship NOTICE alongside

The license-check today allowlists permissive licenses (MIT, BSD, ISC, Apache-2.0, 0BSD, CC0-1.0, Unlicense, Python-2.0) and forbids copyleft (GPL family, MPL, EPL, CDDL, SSPL, CC-BY-SA, CC-BY-NC). Hack itself is MIT (already allowlisted). The Nerd Font patch overlay is SIL OFL 1.1, which is permissive for redistribution embedded in software. The OFL requires that the license text accompany the font and that any modification rename the family — we're shipping the file unmodified, so the rename clause doesn't apply.

We:

- Add `^OFL-1\.1$` / `^SIL.OFL.*1\.1$` to `permissiveLicensePatterns`.
- Drop the upstream MIT `LICENSE.md` and OFL `LICENSE.txt` next to the font under `src/assets/fonts/`.
- Ensure the texts are reachable from the running app — either through whatever existing third-party-notices surface uatu already has, or by serving them under `/assets/fonts/` and linking from a README/ABOUT block.

**Alternative considered:** Treat the font as data, not as a "dependency", and skip license-check changes. Rejected — `bun run check:licenses` is the project's stated guard for legal redistribution; intentionally side-stepping it for the font that we *most* visibly redistribute would be a foot-gun for future contributors.

### Decision 5: Override path is unchanged

The existing requirement `Terminal honors .uatu.json font configuration` already specifies the override mechanism: a `terminal.fontFamily` string in `.uatu.json` is forwarded via `/api/state.terminalConfig` and applied to the xterm instance. That stays exactly as-is. The only spec text that changes is the assertion about what the *default* is when no override is present — today it's "the locally-installed Nerd Fonts the user happens to have", tomorrow it's "the bundled Hack Nerd Font Mono served from `/assets/fonts/`".

This keeps the override surface area zero-touch: existing `.uatu.json` files keep working, existing tests around override behavior keep passing.

### Decision 6: Skip subsetting in v1

Subsetting to only the codepoints actually emitted by popular prompts could drop file size further. But:

- Hack Nerd Font Mono full WOFF2 (1.18 MB) is under the 1.5 MB budget, and the savings from subsetting are modest because each individual icon glyph is small — the count is what costs.
- A subset locks us into a guess about what prompts users run; opinionated `oh-my-posh` themes pulling from less-common ranges would re-encounter TOFU.
- A subsetting pipeline (pyftsubset, fonttools) adds a build dependency.

If size becomes a concern later (we bundle more fonts, the WOFF2 grows on a future release), we'll revisit.

## Risks / Trade-offs

- **Risk:** `local("Hack Nerd Font Mono")` finds a *different* Hack patched build (older Nerd Fonts release, custom modifications) than the one we bundle. Glyphs may differ subtly. → Mitigation: this is acceptable. A user who has installed their own Hack expects their version. The risk to flag is only that a *broken* local copy shadows our bundled one — and the OS install path makes corruption extremely unlikely. We accept this.
- **Risk:** `font-display: block` causes a brief blank state before the font is ready on first load. → Mitigation: preload the font from `index.html` with `<link rel="preload" as="font" type="font/woff2" crossorigin>`. On localhost this turns the blank period into a few milliseconds.
- **Risk:** Hack Nerd Fonts upstream changes the file name or format between releases, breaking our pinned import. → Mitigation: vendor the file into the repo under `src/assets/fonts/` rather than pulling at build time. Document the upstream source and version in a sibling `SOURCE.txt`. Bumping the font is an explicit PR.
- **Risk:** Binary growth (~1.2 MB) hurts cold-start time on slow disks. → Mitigation: smaller than the already-bundled `mermaid.min.js` (~3.2 MB); measured impact on cold start is in the µs range on any modern disk. Acceptable.
- **Risk:** A locked-down deployment sets a strict CSP that blocks the font fetch. → Mitigation: the font is same-origin to the app, so `font-src 'self'` suffices. uatu doesn't ship a CSP today; if one is added later, this is a one-line addition.
- **Trade-off:** A user who prefers JetBrains Mono / FiraCode / Berkeley Mono now sees Hack by default. They have to set `.uatu.json terminal.fontFamily` to their preferred face. Acceptable — that override has always existed and we'll mention it in the upgrade notes if there's any user-facing release-notes channel.

## Migration Plan

No data migration needed. The change is additive for the user:

1. Land the font asset, route, `@font-face`, license updates, and stack edits in one PR.
2. On user upgrade, the new binary serves the bundled face automatically.
3. Users with `.uatu.json terminal.fontFamily` set see no change.
4. Users without that setting transparently move from "whatever the OS monospace is, with broken icons" to "Hack Nerd Font Mono with working icons".
5. Users who *want* the old behavior of letting their OS pick can set `terminal.fontFamily` to whatever face they want in `.uatu.json`.

No rollback complexity — reverting the PR removes the asset and route and the system falls back to today's behavior.

## Open Questions

- Which exact upstream release of Nerd Fonts do we pin Hack to? (Suggest: latest stable at implementation time, recorded in `src/assets/fonts/SOURCE.txt`.)
- Does uatu already have a "third-party notices" UI surface where attribution lives, or do we need to add one? Implementer should grep for "license" / "OFL" / "attribution" in the app before deciding whether to add a route or piggy-back on an existing about page.
- Do we want a release-notes entry calling out "your terminal will now default to Hack Nerd Font Mono — set `terminal.fontFamily` in `.uatu.json` if you prefer something else"? Lean yes, even though most users will see this as an upgrade rather than a regression.
