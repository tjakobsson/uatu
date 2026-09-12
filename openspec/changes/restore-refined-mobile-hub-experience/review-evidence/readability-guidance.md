# Apple guidance recheck: readable facts, fields and choices

> Current entry points: [evidence index](README.md) and [verification](verification.md). This retained research informs the interface; any recorded implementation status belongs to pre-cleanup commit `373ef6350032f6a0f2a91c2037ebafb553bc002f`, not fresh acceptance.

2026-09-10. Research was performed after the requested checkpoint was committed
and pushed: [`c259efb`](https://github.com/addiberra/uatu/commit/c259efb), on
`fork/design/hub-mobile-navigation`. This pass did not install dependencies or
change the published Hub API. Guidance is adapted for the PWA, not native Apple
certification.

## First-party sources revisited

| Source | Relevant guidance | Application here |
| --- | --- | --- |
| [Settings](https://developer.apple.com/design/human-interface-guidelines/settings) | Prefer task-specific options in their task context; distinguish general settings. | Keep actions beside the relevant workspace/credential; one canonical Devices entry in Settings. |
| [Labels](https://developer.apple.com/design/human-interface-guidelines/labels) | “Use a label to display a small amount of text that people don’t need to edit”; use label colors to convey relative importance. | Semantic `dl`/`dt`/`dd` facts with secondary labels and strong values, distinct from editable controls and action rows. |
| [Toggles](https://developer.apple.com/design/human-interface-guidelines/toggles) | “Use the switch toggle style only in a list row”; the default green color generally works well. | Green on/off switches in Boolean rows, with native checked semantics, a moving thumb and accessible labels. Mutually exclusive preferences remain selection rows/radios. |
| [Text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields) | Persistent labels help after placeholders disappear; tab order should match expectations. | Fields get visible boundaries and short hints; editor entry focuses its heading, not a picker or text field. Current/default values are retained. |
| [Entering data](https://developer.apple.com/design/human-interface-guidelines/entering-data) | Validate data and make requirements clear. | Normalize authentication hosts only during explicit Review; show Current / After applying values and the prospective change. No mutation during entry/review. |
| [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback) | Put important information near what it describes; feedback helps people understand outcomes and avoid mistakes. | A prominent inline credential-security notice appears before credentials; review facts separate identity, roles, changed values and timing. |
| [Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts) | Prefer contextual information over alerts used only to inform. | The dismissible notice is inline, not a drawer or interruptive dialog. Existing per-user dismissal remains respected. |

The no-auto-focus rule, direct action placement, switch styling and removal of
the duplicate Devices navigation are user requirements applied with this guidance.
No Apple device-record deduplication rule is claimed: distinct API device records
are preserved even if they have the same display name.

## Semantics kept intact

- Switches are **draft Boolean inputs** in these editors. Turning one on does not
  initialize Git, start a workspace, grant consent effects or delete anything
  before the existing Save/Review/Apply action.
- Saved/default form values are not cleared merely to make controls look idle.
  The fix removes automatic focus/picker activation, not truthful initialization.
- Host changes add/update the selected host; they do not silently remove another
  host. Blank role choices remain unchanged, and signing stays independent.
- Credential assignment is not an access-isolation mechanism or a readiness test.
  The inline notice states the risk plainly; Session Security retains the details.
- Labels/values, controls and commands have distinct presentation. Ordinary
  context commands do not receive a filled blue primary/selected appearance.
