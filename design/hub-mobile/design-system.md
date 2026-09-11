# Uatu Web UI design system

A small, Apple-inspired system for the **mobile Hub and its management flows**.
It is a Web/PWA implementation, not UIKit, SwiftUI, SF Symbols, or an Apple-certified
interface. Existing workspace interiors, monospace content and desktop presentation
are not redesigned by adopting it.

Live reference in the isolated mock review: **`/review/design-system`**.
Examples use the real product modules and styles, not copied control markup.
They never perform Hub mutations and are not a product Settings destination.

## The central rule: meaning determines presentation

| Meaning | Use | Do not use |
| --- | --- | --- |
| Observed information | `infoRows`: labeled, selectable facts with readable values | Disabled inputs, a paragraph wall, or a selected-looking action |
| Supporting explanation | `text`: short secondary copy near the relevant item | The only rendering of important names, paths, status or proposed changes |
| Navigate to an object/page | `listRow`, or `destinationRow` in the shell | A mutation disguised by a disclosure chevron |
| Perform an action | `action`: explicit verb, destructive tone where applicable | A generic More menu or a filled selected-row treatment |
| Edit a value | `field` / `select`: persistent label and a visible editable surface | An unlabeled blank area or page-load autofocus |
| Independent Boolean choice | `check`: native checkbox semantics, accessible green switch | A switch for one-of-many choices; automatic backend writes from a draft |
| Choose one of several values | `choiceGroup`: native radio semantics and checkmark rows | Several independent switches |
| Important security information | Shared `advisory` recipe, before the relevant controls | A hidden footer notice, drawer, or duplicate dismissal controls |
| Review an operation | Groups of `infoRows` with Current / After applying / Change on apply | Prose that mixes identity, current state and future effects |
| Edit or inspect task details | Shared `createTaskView` full-page editor/result | A drawer or a second implementation of focus/history rules |
| Confirm a consequential action | Explicit `env.confirm`: centered, labeled confirmation | An ordinary navigation menu styled as a destructive dialog |

Every action has one natural home. Settings uses top Back and contextual options.
Only genuinely frequent controls need special lower-screen placement. Current
values stay accurate; controls never open themselves merely because a page appeared.

## Product modules and ownership

```text
domain flows / overview
          |
          +--> design-system.ts  semantic, stateless HTML primitives
          |          +--> styles.css  one recipe per pattern
          |                     +--> tokens.css  semantic theme
          |
          +--> flow-ui.ts        binding, validation, async ownership, notices
          +--> task-view.ts      editor/confirmation DOM, focus, pending controls
          +--> task-history.ts   ephemeral workflow history
          +--> layout.ts         measured viewport/keyboard/chrome clearance
```

`flow-ui.ts` and `information.ts` retain compatibility exports, but there is only
one implementation of each stateless primitive. Existing data-action/data-flow,
field names and credential-status markers stay stable.

The design system **does not** own backend effects, authentication, workspace
state, form validation policy, host normalization or credential readiness. Those
remain with existing owners. `body` arguments accept trusted product-composed
HTML; all ordinary text/keys are escaped. The legacy field `attrs` argument is
for trusted static attribute markup only, never unescaped user input.

## Foundations

### Typography

All text roles use rem so browser text enlargement scales them consistently.

| Token | Normal size | Purpose |
| --- | ---: | --- |
| `--mh-type-page` | 34px | Top-level page title |
| `--mh-type-detail`, `--mh-type-editor` | 26px | Object/task title |
| `--mh-type-body`, `--mh-type-value` | 17px | Body text, field and information values |
| `--mh-type-control` | 15px | Compact commands, Back, trailing navigation values, Return identity |
| `--mh-type-secondary`, `--mh-type-label` | 13px | Labels and supporting explanation |
| `--mh-type-navigation` | 11px | Compact dock labels only |

System sans-serif is the UI font. The existing licensed Hack Nerd Font Mono is
used for technical/code text. Do not shrink content to make it fit; wrap and scroll.

### Spacing and shape

`--mh-space-1` … `--mh-space-7` are **4, 8, 12, 16, 20, 24, 32px**.
Shared radius roles cover grouped surfaces, fields, buttons, confirmations and
pills. `--mh-target` is **44px**. Recipe-specific icon art and overview geometry
are local details, not a proliferation of public theme variables.

### Colors and materials

Use semantic roles, not screen-specific hex values:

- Canvas and surface: `--mh-canvas`, `--mh-surface`
- Text hierarchy: `--mh-text`, `--mh-muted`
- Actions versus selection: `--mh-action`, `--mh-action-fill`,
  `--mh-on-action`, `--mh-action-subtle`, `--mh-selected`
- Feedback: `--mh-positive`, `--mh-danger`, `--mh-warning`,
  `--mh-warning-background`
- Controls: `--mh-field-background`, `--mh-field-line`, switch on/off/thumb/line
- Chrome: `--mh-material`, `--mh-scrim`, named shadow roles

Dark appearance and increased contrast change tokens. Reduced motion changes the
motion token; reduced transparency and forced colors have explicit recipes.
Selection color is not a shortcut for styling a primary action. Positive tone
must not make an uncommitted review look already applied.

### Measured layout is not a theme

`--mh-keyboard-clearance`, dock/toolbar heights, prompt height and visible height
come from `layout.ts`. Never replace them with theme constants or create a second
measurement owner. Task headers and scroll regions must keep controls reachable
above keyboard/safe areas without covering the final content.

## Usage examples

```ts
import { action, field, group, infoRows, listRow } from "./design-system";

const content = group("Workspace", infoRows([
  { label: "Folder", value: workspace.path, mono: true },
  { label: "Status", value: "Running", tone: "positive" },
]));

const options = group("Actions",
  listRow("credentials", "Workspace credentials", "Authentication and signing", "key")
  + action("stop", "Stop workspace", true),
);

// The existing flow owner binds commands and owns validation/effects.
env.page(workspace.displayName, content + options, actions);
env.task("Rename workspace", field("name", "Display name", workspace.displayName), {
  label: "Save",
  run: task => saveValidatedDraft(task),
});
```

`destinationRow` is the shell's tinted-icon navigation recipe and uses data-action.
`listRow` is object navigation and uses data-flow. Neither hides commands in More.
`action` is for immediate commands; the owning flow supplies confirmation when needed.

## State and accessibility contract

- Rendering a primitive emits no change events and performs no storage/network work.
- Switches and radio selections remain drafts until the existing Save/Review/Apply.
- Editor entry focuses a noninteractive heading, never a field or native picker.
- Only centered confirmations trap Tab. Underlying views are inactive during tasks.
- Pending Back cannot reopen a resubmittable editor or lose its operation result.
- Cancel/back clears secret controls at the established lifetime points; no secrets
  or drafts enter history. Forward does not replay an expired operation.
- Use native disabled/checked semantics, visible keyboard focus and text feedback.
- Mark invalid fields and explain the error; never convey state by color alone.
- Read-only metadata and hidden-view enrichment do not acquire mutation ownership.
- Full-page forms, long values, 200% text and constrained viewports must remain usable.

## Adding a pattern

### Folder selection is not folder management

Use `createFolderPicker` for choosing a directory on the **remote Hub**. It uses
the shared full-page TaskView with fixed Cancel/current-folder/Choose navigation
and a single scrolling folder body. Directory rows navigate; only Choose returns
the verified current path. Choose is disabled during loading/error; Cancel stays
available. Full paths remain readable/selectable even when a long header title
uses ellipsis. The underlying Hub dock is inactive, not a competing destination.

The picker has only a `browseFolders` backend capability. Do not add workspace
creation, registration, rename or delete commands to it. Those stay in **Add
Workspace → Manage folders**, with the existing safeguards and direct actions.
Manual path entry remains in calling editors or management. Don't invent Files
favorites/search/locations that the Hub API doesn't supply, and don't invoke an
iPhone file picker for a server-side folder.

The reference catalog's **Choose Hub folder** example uses this actual module
with a static, test-owned directory tree and no real filesystem requests.

### Extension discipline

1. Choose the existing semantic primitive first. Do not paste a local replacement.
2. Put reused visual decisions in tokens; put one authoritative recipe in styles.
3. Keep domain policy and lifecycle with their current owners.
4. If a genuinely new pattern is needed, add its real caller and reference example
   together. Do not add a hypothetical renderer registry or dependency.
5. Test escaping, meaning/roles, relevant states and the actual flow—not merely
   element presence or a screenshot capture.

The reference catalog is under `tests/mobile-hub-review/design-system*` and is
separately bundled/served. It must never enter the shipping viewport bundle.
Existing optical/reference captures are evidence, not automatically approved goldens.

## Guidance

Inspired by Apple's [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/),
especially [Settings](https://developer.apple.com/design/human-interface-guidelines/settings),
[Labels](https://developer.apple.com/design/human-interface-guidelines/labels),
[Toggles](https://developer.apple.com/design/human-interface-guidelines/toggles),
[Text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields),
and [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback).
The project-specific research and explicit user decisions remain in the current
change's review evidence. No proprietary symbol/font package is introduced.
