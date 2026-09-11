# Superseded artifact cleanup — 2026-09-11

User-approved narrow cleanup while this change remains unfinished. Removals are
recorded in a **new normal commit**, not stripped from earlier history. Privacy
sanitization/history rewriting is separate and requires later confirmation.

## Scope and recovery

- **264** older derived PNGs: 64 in `visual/`, 200 in `visual/corrected/`.
  Exact nonrecursive suffixes: `-normalized.png`, `-side.png`, `-overlay.png`,
  `-diff.png`. No `visual/review-ready/` files are included.
- **115** byte-identical responsive-history PNG copies, mapped below.
- `tests/mobile-hub-review/newstage12.browser.ts`: retired because its Devices
  placement assertion contradicts the current Security hierarchy. Current tests
  and the remaining editor-entry audit retain the relevant assertions.

Total: **380 removed paths**, approximately **28 MiB** of uncompressed content.
This reduces the current tree/PR diff, not historical Git object storage.

All original paths remain in pre-cleanup commit `8fc4811`. For example,
`git show 8fc4811:openspec/changes/restore-refined-mobile-hub-experience/review-evidence/visual/chromium-hub-side.png`
emits the original PNG bytes for recovery to a chosen local file.

Keep all original references, actual visual captures, latest review-ready
comparisons, unique responsive captures, every result JSON (including failed and
untested runs), measurements, preservation manifests, baseline fixtures,
diagnostic tools and written findings. Historical hashes/results have not been
recomputed or relabeled as approval. Earlier gallery links now use retained actuals
and name the canonical references.

## Responsive duplicate map

Paths are relative to `responsive/`. Each removed `history/<run>/<filename>` had
the **same Git blob** as retained `<filename>` at cleanup time. Matching bytes do
not imply identical run conditions; the untouched per-run `results.json` records
those. This maps 115 removed paths to 21 retained filename contexts and 19 image
blobs. Contrast/reduced-motion pairs retain their separate semantic filenames.

| Run | Historical directory |
|---|---|
| A | `2026-09-10T00-46-29-069Z` |
| B | `2026-09-10T01-06-33-051Z` |
| C | `2026-09-10T01-16-49-444Z` |
| D | `2026-09-10T01-24-57-679Z` |
| E | `2026-09-10T01-31-39-606Z` |
| F | `2026-09-10T01-39-02-234Z` |
| G | `2026-09-10T01-51-36-896Z` |

| Retained filename | Removed copies in runs | Git blob at cleanup |
|---|---|---|
| `chromium-320x740-dark-200-credential.png` | A, B, C, D, E, F, G | `8494afdb005b19216542b640e0e4795a7de821f7` |
| `chromium-320x740-dark-200-preference.png` | A, B, C, D, E, F, G | `92ceb12ee5cf2b842490a0008be4e866250e9663` |
| `chromium-320x740-light-200-credential.png` | A, B, C, D, E, F, G | `a2d8269e7354022d5164153891ff63589848da81` |
| `chromium-320x740-light-200-preference.png` | A, B, C, D, E, F, G | `9f452f90555306121a248c76812087ba8939e28d` |
| `chromium-844x390-light-200-onboard.png` | A, B, C, D, E, F | `9117df4d9f829dd147704ec860f347dc6acad6d4` |
| `chromium-contrast.png` | A, B, C, D, E, F, G | `47691e523ddf5a8b5b13819075785b81a9fb185b` |
| `chromium-forced-colors.png` | A, B, C, D, E, F, G | `0d92c7f6e8b6c4f8a0597d15ee8cb83024dde736` |
| `chromium-reduced-motion.png` | A, B, C, D, E, F, G | `47691e523ddf5a8b5b13819075785b81a9fb185b` |
| `webkit-320x740-dark-200-credential.png` | A, B, C, D, E, F, G | `e54f206c69bcdbf80bbe6f6255f4178c468df1fd` |
| `webkit-320x740-light-200-credential.png` | A, B, C, D, E, F, G | `121c49e3bc9e89a1f9c58921a9ac0192b0080ce5` |
| `webkit-320x740-light-200-preference.png` | A, B, C, D, E, F, G | `add3a718875e46e24b34ff174d20ca8871b957e4` |
| `webkit-contrast.png` | A, B, C, D, E, F, G | `a596738825d8268274acd4620efffb100f957389` |
| `webkit-forced-colors.png` | A, B, C, D, E, F, G | `fe619763dca04ef2731b27fa4b04ce8958f0dc5f` |
| `webkit-reduced-motion.png` | A, B, C, D, E, F, G | `a596738825d8268274acd4620efffb100f957389` |
| `chromium-reduced-transparency.png` | B, C, D, E, F, G | `c07c307f5d39c6e59acf65622bf8a49414d3587a` |
| `webkit-844x390-dark-200-onboard.png` | B, G | `c40c515a4931be7e515f12bca2a2bad8b6e5ed91` |
| `webkit-844x390-light-200-onboard.png` | B, C, D, F, G | `b03287436fae5b92e63bfc87a2f2c43da1063792` |
| `chromium-844x390-dark-200-onboard.png` | D | `540a9283783be93ff0aafd57d843c46ce7ebb6cf` |
| `webkit-320x740-light-100-assignment.png` | F, G | `4022b1710e4edc6cd925700501d5f586da9921fe` |
| `chromium-320x740-light-200-keyboard-viewport.png` | G | `81139d6873307a0e6c24a028153220b419e5be57` |
| `webkit-320x740-light-200-keyboard-viewport.png` | G | `1c9f6c914a3eff4985de05a0e3fcc092e90a96fa` |

If a later run changes a current screenshot, the blob still identifies original
bytes in retained Git history (`git show <blob>`). Do not reinterpret a new image
at the same filename as a historical run's capture.

## Unchanged gates

Cleanup verification passed: exactly 380 approved staged deletions, all 115
duplicate mappings checked against Git blobs, and retained canonical/actual/latest
images and result JSON unchanged. Both earlier gallery scripts render their
expected actuals/pairs and every retained local image/navigation link resolves.
The focused product/reviewer/preview/boot suite plus preservation-baseline tests
passed **440 tests / 5366 assertions**; product and reviewer TypeScript checks
and whitespace checks passed. No product code, server runtime or test assertion
was removed to obtain those passes. The running review server was not restarted.

No visual approval, approved goldens, complete current full-app matrix, physical
device certification or live-integration authorization is inferred. Pending tasks
7.1, 7.4, 8.3, 9.6, 10.4 and 11.4 remain pending. Local workflow deletions, private
state, the separate worktree and retained raw diagnostics are outside this commit.
