# Apple iOS guidance and Uatu operation constraints

> Current entry points: [evidence index](README.md) and [verification](verification.md). This retained research informs the interface; any recorded implementation status belongs to pre-cleanup commit `373ef6350032f6a0f2a91c2037ebafb553bc002f`, not fresh acceptance.

Researched 2026-09-10 from [Apple Design](https://developer.apple.com/design/)
and Apple's first-party Human Interface Guidelines/DocC documents. These are
guidelines adapted to a web/PWA, not Apple certification or native UIKit behavior.

## Applicable first-party guidance

| Official source | Guidance and application |
| --- | --- |
| [Lists and tables](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables) | “Keep item text succinct”; avoid “over-large table rows,” revealing longer content in detail views. Folder/name rows form one grouped list with disclosure, not one action-card section per folder. |
| [Menus](https://developer.apple.com/design/human-interface-guidelines/menus) | Use succinct action labels, frequent commands first, short logically grouped menus and shallow hierarchy. |
| [Pull-down buttons](https://developer.apple.com/design/human-interface-guidelines/pull-down-buttons) | Do not put every action in a More menu: keep the task's primary discoverable. |
| [Context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus) | Short contextual commands; never make long-press the exclusive access path. Visible More is the access path here; destructive items last. |
| [Action sheets](https://developer.apple.com/design/human-interface-guidelines/action-sheets) | Choices following an intentional action, not generic informational alerts. Keep choices short; a long scrolling form is a task sheet, not an action sheet. |
| [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets) | Scoped task related to current context; preserve context and provide clear completion/cancellation. |
| [Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts) | Use sparingly for important actionable interruptions; specific titles and verbs, not generic Error/OK. Do not change existing destructive safeguards merely to reduce taps. |
| [Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars), [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars) | Tabs navigate top-level sections; toolbars act on current content. Keep Hub/Settings/Return distinct from a task's Back/primary/More controls. |
| [Labels](https://developer.apple.com/design/human-interface-guidelines/labels) | Relative importance and succinct labels; useful paths, identifiers and diagnostics remain selectable in details. |
| [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback) | Status near affected content; explain unavailable actions and recovery; don't rely on color alone. Show readiness outcome/blocker first and disclose technical checks. |
| [Loading](https://developer.apple.com/design/human-interface-guidelines/loading) | Show content/structure promptly, communicate progress and permit unrelated work; uncertainty is not confirmed failure. |
| [Text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields), [Pickers](https://developer.apple.com/design/human-interface-guidelines/pickers) | Persistent field labels, appropriate keyboards, secure sensitive input, logical selection order and contextual validation. Preserve supported choices and current values. |
| [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility), [Typography](https://developer.apple.com/design/human-interface-guidelines/typography), [Layout](https://developer.apple.com/design/human-interface-guidelines/layout) | Legibility, larger text, understandable names, focus order, safe areas and sufficient targets. Project acceptance remains at least 44×44 CSS px; Apple's native measurement is points. Browser stress does not certify physical VoiceOver/Dynamic Type. |
| [Materials](https://developer.apple.com/design/human-interface-guidelines/materials), [Color](https://developer.apple.com/design/human-interface-guidelines/color) | Material distinguishes navigation/context while maintaining contrast. Preserve restrained reference materials and opaque accessibility alternatives; do not claim native Liquid Glass rendering. |

The **lower-half frequent-command requirement and no duplicate button rule are
explicit user decisions**, not claims that Apple mandates all controls at the
bottom. Hierarchical list items scroll naturally; primary completion and routine
navigation have one lower-screen home. Move controls; don't copy them.

## Uatu API reference

Source of truth: `api/openapi.yaml`, `api/operations.yaml`; published at
<https://tjakobsson.github.io/uatu/api/openapi.yaml>.

- Browse (`hubBrowse`) supplies child names, Git and registration/running facts.
  A row can navigate once, with secondary management exposed contextually.
- Create empty folder, create Git workspace and configure existing folder are
  distinct operations. Registration and assignment commit precedes optional
  Start; partial results may retain checkout or registration. Preserve consent.
- Stop terminates sessions; Forget unregisters a stopped workspace without
  deleting files. Rename folder and rename workspace label are distinct.
- Assignment authentication needs a host; signing is separate. Selected roles
  may be atomically replaced; omitted roles do not mean remove. Required stops
  precede mutations. No presentation change grants credential isolation.
- SSH/OpenPGP/token capabilities remain distinct; public metadata is not secret
  storage. Imports are bounded and cleared, masked secrets never redisplayed.
- Credential readiness rows contain **layer/status/message only**
  (`openapi.yaml`, `ReadinessResult`). Repeated layers are valid; don't attribute
  them to tools by array order or parse diagnostic prose. Summarize by supplied
  status/layer and retain every original result in disclosure. Tool results can
  be named by their enclosing `PublicCredentialTool.tool`.
- Device inventory gives issued time, not last active. Revoking current access
  signs out this client without Stop.
- Clone identity and retained auth/signing are distinct. Cancellation ack is not
  terminal outcome; masked prompt input and uncertain acceptance retain their
  existing owner/reconciliation behavior.
- `readCredentialFacts`, `readToolConfiguration` and clone attempt reconciliation
  remain approved **unpublished frontend seams**, not invented public endpoints.

## Acceptance checks for this correction

1. Compact folder groups, no repeated Browse button beside a second row target.
2. Readiness summary/blocker immediately useful; all raw diagnostics inspectable.
3. Exactly one visible Back and one task-primary; no upper and lower copies.
4. Frequent commands in the lower half at phone portrait sizes and safely visible
   in short/keyboard viewports, with scroll clearance for toolbar/dock/safe area.
5. Menus contextual and concise; form fields stay in sheets, not long action menus.
6. No duplicate Cancel/Back-to-edit paths with identical consequences.
7. No lost operations, altered payloads/ordering, secret retention or stale races.
8. All 27 screens and their pending/error/cancel/recovery families reviewed;
   observed, tested, untested and physical-device limits remain explicit.
