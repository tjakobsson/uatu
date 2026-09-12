# Task 1.1 — retained reference and dirty-tree evidence

> Current entry points: [evidence index](README.md) and [verification](verification.md). The canonical 49-reference normalization table and baseline below remain useful and retained. Other generated-artifact paths and recorded status are historical at pre-cleanup commit `373ef6350032f6a0f2a91c2037ebafb553bc002f`, not new acceptance.

Recorded 2026-09-09, before product implementation for this change. This is an
offline inventory, **not frontend acceptance**, new visual goldens, or evidence
of live backend behavior. `tasks.md` is deliberately unchanged (lead-owned).

## Safety baseline

[`baseline.json`](baseline.json) records the initial 94 porcelain status entries:
52 modified tracked files, 13 tracked deletions, and 29 untracked entries (some
are collapsed directories). HEAD is `0ba1dad3e96dc7ac8a81f8f820a5e0d9488ffd69`.
The entire staged-index listing has its own SHA-256. No index changes were made.

The three safety digests bind sorted file paths, permission modes, byte counts,
SHA-256 content hashes and explicit absence records, using canonical JSON-lines
as implemented in [`baseline.ts`](baseline.ts). Group counts overlap:

| Group | Records | SHA-256 |
| --- | ---: | --- |
| Original reference (49 PNGs + README/gallery/report) | 52 | `38940ab1a56a7195f574b1dd3a124d463946ff864ed513384849a13f4bfea6b0` |
| User's retained historical archive | 25 | `123a7512ad3b3b5b0043d298c7d9500f70a9ece30e48e9d160603281e5f7de60` |
| Approved repository source/docs/test evidence, including dirty files and deletions | 1632 | `d6087d19462878d79381b501ec0de81f219d6d52f8b730d92e26651f39a7a988` |

The repository group includes the current planning artifacts, user-modified
product sources, existing test sources and retained screenshot evidence. It is
deliberately broader than the changed files, so a new/deleted approved file or a
change to a formerly clean source also fails verification. This is a detection
manifest, not a backup or a restore script; it never repairs or resets anything.

**Privacy and coverage limits:** `.local/` and `fix-chat-send-button/` are recorded
only as pre-existing untracked directory names. Their contents were not opened,
enumerated by the evidence script, or hashed. No secrets, credential storage,
host configuration, ignored dependency trees, or arbitrary untracked roots are
inventoried. The explicit path allowlist and conservative secret-name exclusion
are in the script (the latter also excludes credential-named source modules).
No byte-level preservation claim is made for excluded paths; this worker issued
no write operation to them. All authored files are new files in this evidence
directory, excluded from the snapshot to permit documentation without rebasing
the initial evidence. All edits were made with `apply_patch`; the script only
reads approved evidence and prints to stdout. No service, install, live Hub,
credential tool, provider, PTY, commit, or archive operation was performed.

Run from the repository root:

```sh
bun openspec/changes/restore-refined-mobile-hub-experience/review-evidence/baseline.ts verify
bun test openspec/changes/restore-refined-mobile-hub-experience/review-evidence/baseline.test.ts
```

`capture` prints a fresh inventory, but does **not** update the saved baseline.
`metadata` prints the original PNG EXIF bytes. Verification exits nonzero if
HEAD, index listing, original status, approved file groups, or image dimensions
change. Once the lead begins other tasks, expected intentional changes will
make the original snapshot fail; preserve this file and explain the delta,
never replace the initial digest to conceal it.

## Source provenance and normalization policy

Original files are at [`design/hub-mobile/`](../../../../design/hub-mobile/).
Contrary to the initial possibility of ignored files, `git ls-files` confirms
all 52 are tracked. `git log -- design/hub-mobile` identifies their introduction
in `0ba1dad` on 2026-09-08; that commit retains static artifacts, not the removed
capture scripts. `refined-results.json` identifies historical WebKit captures,
generated `2026-09-08T14:29:53.629Z`, against workspace frontend commit
`b697458f08b1cc1208836cd2db99a3d6f58b4216`. Its 82 checks are historical prototype
claims, not tests run for this change. README/gallery references to the old
change and iframe mechanics remain historical text; neither was rewritten.

Every PNG's IHDR dimensions were inspected. All have IHDR, sRGB, eXIf, IDAT and
IEND chunks; none contains pHYs or a text capture-configuration record. Decoding
the big-endian TIFF EXIF shows only the Exif IFD pointer (`0x8769`), color space
(`0xA001 = 1`), pixel X/Y dimensions (`0xA002/0xA003`). These repeat pixel sizes,
**not CSS viewport or browser DPR**. EXIF does not resolve normalization.

The historical report explicitly states **320×740 and 844×390 at 200% fonts**
for the six `large-text-*` images. Their PNG sizes equal those CSS dimensions:
the normalization factor is 1 output pixel per CSS pixel, regardless of the
unknown original browser DPR/screenshot scale option. Font enlargement refers
to the prototype's navigation/Hub treatment; it is not license to double the
current workspace interior fonts.

The user approved the following **comparison normalization**, conditional on
correct iPhone dimensions. The installed Playwright iPhone 12/13 descriptors
were verified: screen 390×844, default browser viewport 390×664, deviceScaleFactor
3; the landscape screen is 844×390. Thus 390×844 is a full-screen comparison
viewport, not the named descriptor's default browser viewport. 320×740 is a
small-screen stress viewport, **not a named iPhone**. Configure these comparison
viewports explicitly rather than relying on device defaults.

| PNG pixels | Approved comparison CSS viewport | Output pixels per CSS pixel |
| --- | --- | --- |
| 780×1688 | 390×844 | 2 |
| 640×1480 | 320×740 | 2 |
| 1688×780 | 844×390 | 2 |
| 390×844 | 390×844 | 1 |
| Six large-text captures | Their explicitly documented dimensions | 1 |

This resolves comparison normalization for all 47 full captures by explicit
approval, not recovered historical capture configuration. **Exact historical
browser DPR remains unknown**; 2× PNG output scale is not native iPhone DPR 3.
The two interior crops are retained for historical preservation only, not
viewport goldens; their origin/scale remain unknown and need no viewport mapping.
Gallery CSS is layout for the gallery, not a source of product font tokens.

## Image/state index (all 49 originals)

Paths below are relative to `design/hub-mobile/screenshots-refined/`. The CSS
viewport / scale column uses the approved comparison policy above, not a claim
of historical browser DPR. `crop` means historical preservation only, no viewport
golden; crop origin/scale are unknown. Pictured states do not certify behavior.
State meanings come from `refined.html`, its report, `reference-contract.md`,
and `screen-map.md`; representative Hub, large-text sheet and Keep Open images
were also visually inspected. Pixel dimensions are independently measured.

Exception codes: **B** current UatuCode name/logo replace prototype identity and
review labels; **D** synthetic data substitutions retain hierarchy/density;
**I** preserve current real workspace interiors rather than historical artwork;
**A** documented accessibility adaptation. Codes are applied only where relevant
but the global contract always applies, including to dimmed backgrounds.

| Image | Pixels | CSS viewport / scale | State / screen-map anchor | Exceptions |
| --- | --- | --- | --- | --- |
| `01-hub.png` | 780×1688 | 390×844 / 2 | Fresh mixed dashboard, Running/Ready groups, two-item dock; H02/H03/H05/A01 | B D |
| `02-preview-collapsed.png` | 780×1688 | 390×844 / 2 | Preview with collapsed handle; W01/W02 | D I |
| `03-main-baseline.png` | 780×1688 | 390×844 / 2 | Historical full-height Preview, no overlay/gutter; W01 | D I |
| `04-preview-expanded.png` | 780×1688 | 390×844 / 2 | Preview selected, expanded selector; W02 | D I |
| `05-files-collapsed.png` | 780×1688 | 390×844 / 2 | Files with collapsed handle; W01/W02 | D I |
| `06-chat-collapsed.png` | 780×1688 | 390×844 / 2 | Chat with collapsed handle; W01/W02 | D I |
| `07-chat-expanded.png` | 780×1688 | 390×844 / 2 | Chat selected, expanded selector; W02 | D I |
| `08-return-hub.png` | 780×1688 | 390×844 / 2 | Visited dashboard, two-line Return segment; H05 | B D |
| `09-terminal-collapsed.png` | 780×1688 | 390×844 / 2 | Terminal deep-blue/cyan collapsed handle; W02 | D I |
| `10-terminal-expanded.png` | 780×1688 | 390×844 / 2 | Terminal selected, deep-blue/cyan selector; W02 | D I |
| `11-moved-handle.png` | 780×1688 | 390×844 / 2 | Repositioned collapsed handle; W02 | D I |
| `12-moved-handle-expanded.png` | 780×1688 | 390×844 / 2 | Expanded selector remains bottom after handle movement; W02 | D I |
| `13-materialize-expand.png` | 780×1688 | 390×844 / 2 | Paused local fade-in midpoint, not stable golden; W02 | D I |
| `14-materialize-collapse.png` | 780×1688 | 390×844 / 2 | Paused local fade-out midpoint, not stable golden; W02 | D I |
| `15-return-in-settings.png` | 780×1688 | 390×844 / 2 | Grouped Settings identity/destinations with Return; S01/H05 | B D |
| `16-workspace-entry.png` | 780×1688 | 390×844 / 2 | Entry selector expanded; W01/W02 | D I |
| `17-workspace-return.png` | 780×1688 | 390×844 / 2 | Return selector expanded; W01/W02 | D I |
| `18-preview-file-controls.png` | 780×1688 | 390×844 / 2 | Left file pill raised over expanded selector; W03 | D I |
| `19-preview-controls-lowered.png` | 780×1688 | 390×844 / 2 | Left file pill lowered after selector collapse; W03 | D I |
| `20-preview-image-first.png` | 780×1688 | 390×844 / 2 | First sibling image, Previous disabled; W03 | D I |
| `21-preview-image-next.png` | 780×1688 | 390×844 / 2 | Next sibling image; W03 | D I |
| `22-preview-side-setting.png` | 780×1688 | 390×844 / 2 | Preview File Controls sheet over Settings; S10/S01 | B D |
| `23-preview-controls-right.png` | 780×1688 | 390×844 / 2 | Right-side file pill; W03 | D I |
| `24-preview-image-last.png` | 780×1688 | 390×844 / 2 | Last sibling image, Next disabled; W03 | D I |
| `25-preview-single-file.png` | 780×1688 | 390×844 / 2 | Confirmed only sibling, arrows absent; W03 | D I |
| `26-preview-index-error.png` | 780×1688 | 390×844 / 2 | Separate index-error/Retry alert above pill; W03 | D I |
| `27-preview-navigation-timeout.png` | 780×1688 | 390×844 / 2 | Navigation timeout/Retry, not boundary; W03 | D I |
| `30-history-stopped.png` | 390×844 | 390×844 / 1 | Stopped-history notice and explicit Start recovery; H02/H05 | B D |
| `31-defaults-draft.png` | 390×844 | 390×844 / 1 | Workspace Defaults draft over SSH detail; S08/S04 | B D |
| `32-clone-unlock.png` | 390×844 | 390×844 / 1 | Unlock Clone Identity recovery sheet; A05 | B D |
| `33-keep-navigation-open.png` | 390×844 | 390×844 / 1 | Keep Open: expanded Preview selector and pill; W02/S10 | D I |
| `dark-collapsed.png` | 780×1688 | 390×844 / 2 | Dark workspace collapsed overlay; W02 | D I A |
| `dark-expanded.png` | 780×1688 | 390×844 / 2 | Dark workspace expanded overlay; W02 | D I A |
| `dark-terminal-collapsed.png` | 780×1688 | 390×844 / 2 | Dark Terminal collapsed overlay; W02 | D I A |
| `dark-terminal-expanded.png` | 780×1688 | 390×844 / 2 | Dark Terminal expanded overlay; W02 | D I A |
| `landscape-collapsed.png` | 1688×780 | 844×390 / 2 | Short landscape collapsed overlay; W02 | D I A |
| `landscape-expanded.png` | 1688×780 | 844×390 / 2 | Short landscape expanded overlay; W02 | D I A |
| `large-text-320x740-hub.png` | 320×740 | 320×740 / 1 | 200% Hub text, wrapping Return; H05 | B D A |
| `large-text-320x740-preview.png` | 320×740 | 320×740 / 1 | Enlarged navigation, current-interior principle; W02/W03 | D I A |
| `large-text-320x740-sheet.png` | 320×740 | 320×740 / 1 | 200% Preview-side sheet, body scrolled, footer visible; S10 | B D A |
| `large-text-844x390-hub.png` | 844×390 | 844×390 / 1 | 200% short landscape Hub/Return; H05 | B D A |
| `large-text-844x390-preview.png` | 844×390 | 844×390 / 1 | Enlarged short landscape navigation; W02/W03 | D I A |
| `large-text-844x390-sheet.png` | 844×390 | 844×390 / 1 | 200% short landscape Preview-side sheet; S10 | B D A |
| `main-original-interior.png` | 636×1520 | crop | Historical interior comparison baseline; W01 | D I |
| `main-refined-interior.png` | 636×1520 | crop | Historical interior comparison with refinement; W01 | D I |
| `reduced-motion-collapsed.png` | 780×1688 | 390×844 / 2 | Reduced Motion collapsed overlay; W02 | D I A |
| `reduced-motion-expanded.png` | 780×1688 | 390×844 / 2 | Reduced Motion expanded overlay; W02 | D I A |
| `small-collapsed.png` | 640×1480 | 320×740 / 2 | Small stress viewport collapsed overlay; W02 | D I A |
| `small-expanded.png` | 640×1480 | 320×740 / 2 | Small stress viewport expanded overlay; W02 | D I A |

### Branding/data exception application

- Keep the **current UatuCode wordmark/name and logo**, preserving the compact
  header geometry around them. Do not reproduce the eye mark, “Uatu Hub”,
  “Refined B”, “B / One dock”, or “sample hub” as shipping UI. This does not exempt
  folder/branch/ellipsis/grid/gear icons, grouped rows, sheet geometry or dock
  materials from reference comparison.
- Northstar, studio.local, `/home/studio/Projects/...`, names, timestamps, keys,
  branches and prose are historical fictional content. Later fixtures must be
  deterministic synthetic replacements with comparable density, not live claims.
  No replacement fixture catalog or current screenshot is supplied by task 1.1.
- Clone demo instructions/passphrases and simulation toasts are not product
  behavior. Review provenance belongs beside evidence or in separate test chrome.
- Old Files/Preview/Chat/Terminal content and fonts are not replacement goldens
  for current interiors. No screenshot surface, iframe, or fake client is allowed.
- Keep 44px targets, focus/semantics and text reflow. Reduced Motion removes
  travel; reduced transparency/forced colors are explicit alternate states.
  Pictured dark workspace overlays do not imply an approved dark Hub design.

## Results, gaps and handoff

No original reference, historical archive, product file or planning
artifact was edited. The original dirty tree is not interpreted as this worker's
implementation, and historical browser passes are not inherited.

### Executed verification (2026-09-09)

| Command | Observed result |
| --- | --- |
| `bun openspec/changes/restore-refined-mobile-hub-experience/review-evidence/baseline.ts capture` | Initial inventory: 94 status entries, 1632 approved records, 49 PNG dimensions. Output copied into the new manifest with `apply_patch`. |
| `bun openspec/changes/restore-refined-mobile-hub-experience/review-evidence/baseline.ts metadata` | EXIF inspected for all 49 PNGs; color space and image pixel dimensions only. |
| `bun openspec/changes/restore-refined-mobile-hub-experience/review-evidence/baseline.ts verify` | **Drift detected**, exit 1: status and approved repository group changed. HEAD, index, reference/archive hashes and image inventory unchanged. |
| `bun openspec/changes/restore-refined-mobile-hub-experience/review-evidence/baseline.ts verify-with-additions src/hub/mobile/` | **PASS**, exit 0, `changed: []`: all original 1632 approved records, original status, HEAD/index and reference/archive digests match. Explicitly excludes only the independently new concurrent directory. |
| `bun test ./openspec/changes/restore-refined-mobile-hub-experience/review-evidence/baseline.test.ts` | **PASS** after approved normalization update, 3 tests, 215 expectations, 0 failures, 102ms (Bun 1.4.2). Covers private-path exclusions, all 49 unique image/state rows, measured dimensions and approved comparison normalization (including preservation-only crops), initial status counts. |
| `git diff --check` | **PASS**, exit 0; no tracked whitespace errors. New evidence is untracked and is checked by its focused tests rather than implied covered by this command. |

The concurrent additions observed were `src/hub/mobile/backend.ts` and
`src/hub/mobile/backend.test.ts`, neither authored or edited by this worker.
The unadjusted group grew from 1632 to 1634 records and had digest
`05ebe92c5dbd65f2bab823de2006e824ef9305b4f46af5623a5e0b1d3d84d5f7` at the failed
check. That is not installed as a replacement baseline. The explicit
`verify-with-additions` mode refuses directories represented in the initial
dirty status or tracked index; it reports its exclusion in output. It proves
original evidence remained unchanged despite independent new work, not that the
concurrent files were tested or approved. Future intentional edits to original
files must still produce a failure and need their own accounted delta.

**Normalization resolved:** explicit user approval establishes the comparison
viewports/scales for all 47 full captures after verification of the installed
iPhone descriptors. The two crops are historical preservation, not viewport
goldens. Exact historical DPR remains unknown and is not needed for this approved
comparison policy. Task 1.1's preservation inventory, complete 49-image state
mapping and comparison normalization are complete; this does not constitute a
frontend visual pass or user acceptance of implementation. Original baseline
hashes are unchanged. The lead owns the task checkbox.

Unpictured login, dark Hub, empty/loading/error dashboards, most credential and
onboarding flows, devices/security and accessibility extensions retain their
E/D classification in `screen-map.md`; no prior visual approval is claimed.
New screenshots, regression tolerances/masks, live review launch and user
acceptance are later tasks and were not undertaken here.
