# Refined-reference contract

## Target and exceptions

The visual target is **the exact refined reference**, not “iOS-inspired” generic
cards. Source: `design/hub-mobile/refined.html` and its 49 images in
`design/hub-mobile/screenshots-refined/`. Filenames below are relative to that
directory. The contract applies to touch/mobile Hub and its workspace navigation
overlays; desktop and the current workspace interiors are not redesigned.

The frontend reviewed in this change is the shipping implementation driven by
test-owned synthetic services. It must remain suitable for subsequent live
adapter integration, not be replaced after review. No backend implementation or
live privileged operation is part of this phase.

Explicit exceptions and adaptations:

- **Branding:** retain the current UatuCode name and logo. Do not restore “Uatu
  Hub”, the prototype eye mark, “Refined B”, “B / One dock”, “sample hub”, or a
  fictional identity as product branding. Preserve the reference header/card
  proportions around the current assets.
- **Data is not artwork:** do not require Northstar, studio.local, paths,
  timestamps, sample prose, key names or branch strings to match screenshot text.
  Preserve their hierarchy and density with representative, visibly simulated
  fixtures. Never imply fixture branch/readiness/session data was measured live.
- **Accessibility:** maintain at least 44px interactive targets, scalable text,
  meaningful icon labels, focus visibility, inert hidden controls, keyboard and
  screen-reader semantics. Reduced Motion removes animation; reduced transparency
  and forced colors use legible opaque/system alternatives. These are explicit
  alternative states, not permission to replace the normal material with a dark
  border everywhere. Review enlargement/reflow rather than clipping to the image.
- **Current interiors:** render current Files/Preview/Chat/Terminal modules with
  synthetic services. The old baseline crops demonstrate the non-redesign
  principle, not a requirement to regress current content to the old commit or
  place an image over a different UI. No iframe, screenshot surface or duplicate
  fake Chat/Terminal is acceptable.

## Visual grammar

At matching viewports, compare outer insets, vertical rhythm, group gaps, icon
size/stroke, type size/weight/line height, divider starts, corner shapes, action
alignment, overlay bounds and material against the source image. Do not infer
exact CSS tokens from the gallery's own stylesheet. The original implementation
is removed; reconstruction requires image comparison and user review.

| Element | Required normal-state treatment |
| --- | --- |
| Hub canvas | Very light cool gray/lilac field in the light reference; broad clear margins and large vertical spacing, not the dense desktop pane grid. |
| Header | Compact horizontal current-logo/current-wordmark row above the page heading. Any real contextual metadata is subordinate; review-only simulation controls are not header product actions. |
| Typography | System sans-serif hierarchy matching the reference: very large bold page title, strong row names, regular field/action labels, muted gray subtitles and uppercase group captions. Hub paths are subordinate human-readable row text as pictured; do not impose the desktop code-table appearance. Preserve the bundled font on existing monospace/code surfaces. |
| Grouped surfaces | White rounded groups with generous internal spacing. Thin low-contrast separators inset to the text column, not full-width dark outlines. Distinguish rounded grouped rows from a separate standalone card. |
| Icons | Match reference silhouettes and outline weight: blue folder, circled ellipsis, plus, branch indicator; dock grid/gear; workspace folder/browser/chat/terminal; contextual colored rounded-square Settings icons. Use existing assets or local vectors, not emoji, text substitutes or new proprietary symbol/font dependencies. Current logo is the branding exception. |
| Actions | Blue text; pale-blue filled primary Open/Start capsules on rows; saturated blue with white text for final sheet actions; white Cancel capsule. Destructive actions are distinct and named, not implicit in a generic close icon. |
| Status | Green dot plus Running/Connected label when that simulated state is supplied. Gray metadata remains distinct from actionable blue. State never depends on color alone. Branch uses the reference's subordinate branch-icon row; unknown is not fabricated `main`. |
| Docks | Inset floating full-radius material, softly translucent white, subtle luminous rim/shadow. Icon above label, pale blue selected capsule, muted inactive icon/text. No text-only navigation strip and no permanent content gutter in workspace surfaces. |
| Sheets | Dim the actual underlying view; bottom-attached sheet with large top corners, centered small grabber, centered bold heading, fine header separator, grouped white inputs on the cool sheet field. Scroll body independently; reachable bottom action row separated by a hairline with Cancel/primary capsules. No centered desktop dialog masquerading as the phone sheet. |

## Per-state contracts and anchors

| State | Exact composition and behavior to preserve | Reference |
| --- | --- | --- |
| Fresh dashboard | Compact header → Workspaces heading → host/session-count subtitle → RUNNING count/group → READY TO START count/group → explanatory footer → plus-led Add Workspace card. Running rows show folder/name/path, ellipsis, green Running and Open capsule; stopped rows show branch fact and Start capsule. Two-destination Hub/Settings dock; Hub selected. | `01-hub.png` |
| Dashboard after visit | Same content system and restored Hub scroll. Dock adds a wider left Return segment with muted “Return to” over bold workspace label, separated from icon-and-label Hub/Settings. It is not a third equal-width label-only tab. Management of another row does not retarget it. | `08-return-hub.png`, `large-text-320x740-hub.png` |
| Settings overview | Large Settings heading; identity card with large rounded icon, name, host and Connected state. CREDENTIALS group has icon/name/type/state/chevron rows plus Add Credential. WORKSPACES group contains Default Folder, Preview File Controls and Navigation Auto-hide rows with value and chevron; ACCOUNT groups device/security destinations. Keep supporting explanatory text below groups and Return dock available. Do not expand every form inline. | `15-return-in-settings.png`, `22-preview-side-setting.png` |
| Detail page | Back-to-Settings at top; centered contextual icon, prominent title and muted type/capability/state summary; uppercase sections and inset divided white readiness/fact/action groups. Return stays available at the page level; modal sheets properly make it inert. Complete actions are mapped separately, not invented from a partial image. | Visible background of `31-defaults-draft.png` |
| Preview-side sheet | Dims Settings. Preview File Controls heading; POSITION caption; white Side field with label/value; two explanatory paragraphs; Cancel and Done footer. Selected Left/Right applies according to the reviewed save/cancel behavior; it must not reset the workspace. | `22-preview-side-setting.png` |
| Default-assignment sheet | Dims credential detail. Workspace Defaults heading, workspace/state context, DEFAULT group, role and credential controls, current assignment/host and replacement implications, Cancel/Review. Current values initialize truthfully; role switching and Review/back preserve intent. Both auth and signing must remain representable even where the picture shows one role. | `31-defaults-draft.png` |
| Clone-unlock recovery | Dims its underlying flow, bottom Unlock Clone Identity sheet with explanation, masked field, Cancel/Unlock. Non-secret clone form remains owned and recoverable; separate unlock returns without creating a job. Do not copy the demo passphrase into production behavior. | `32-clone-unlock.png` |
| Stopped-history recovery | Contextual notice above dashboard states which target stopped and offers the explicit Start path; count/group state agrees. Retained name is not a live badge. No history-induced start or substitution. Simulation toast is test chrome, not product design. | `30-history-stopped.png` |
| Workspace entry/Return | The real current surface is full-height under the overlay; selector opens after readiness and again on Return without forcing Preview or stealing focus. Ordinary Hub detour leaves current client and ongoing work mounted. | `16-workspace-entry.png`, `17-workspace-return.png` |
| Expanded workspace selector | Single row: Close, separate Hub destination, Files, Preview, Chat, Terminal. Icon above each destination label; selected surface sits in pale blue capsule. No extra Preferences row/button. Expanded selector stays at bottom even when edge handle was moved. | `04-preview-expanded.png`, `07-chat-expanded.png`, `12-moved-handle-expanded.png` |
| Collapsed selector | Small translucent edge-docked chevron, not a permanent tab bar. Retains a comfortable hit target and attention indicators. Drag vertically/either side; keyboard positioning; no accidental click after drag. Seven idle seconds collapse; focus/held pointer protect it. Keep Open disables idle/outside dismissal while retaining Close. | `02-preview-collapsed.png`, `05-files-collapsed.png`, `06-chat-collapsed.png`, `11-moved-handle.png`, `33-keep-navigation-open.png` |
| Preview file pill | Soft translucent rounded pill, folder + Files, fine vertical divider, compact Previous/Next chevrons. Default bottom-left, raised above expanded selector, lowered after collapse; Right mirrors placement. No dark normal-state perimeter. Appears only in Preview and does not redesign the document. | `18-preview-file-controls.png`, `19-preview-controls-lowered.png`, `23-preview-controls-right.png` |
| Preview sequence/error | First/last arrow pale gray and disabled without wrapping; one confirmed sibling hides both arrows. Index failure/timeout produces separate warm-outlined alert above the pill with Retry; Files remains usable. Do not present failure as a boundary. Keep stable root/file identity. | `20-preview-image-first.png`, `21-preview-image-next.png`, `24-preview-image-last.png`, `25-preview-single-file.png`, `26-preview-index-error.png`, `27-preview-navigation-timeout.png` |
| Terminal overlay | Only selector/handle palette changes: deep blue glass, bright labels, cyan luminous rim, pale cyan selected capsule with dark foreground. Retain actual terminal styling, keybar and output-attention ownership. | `09-terminal-collapsed.png`, `10-terminal-expanded.png`, `dark-terminal-collapsed.png`, `dark-terminal-expanded.png` |
| Motion | Workspace reveals Hub underneath by moving right, with Hub scroll retained; ordinary Return restores the same workspace. Selector alone fades in place about 180ms in / 280ms out, interruptible and immediately interactive; no genie travel, scale or bounce. Reduced Motion is immediate. | `refined.html` paragraphs on motion/return; `13-materialize-expand.png`, `14-materialize-collapse.png`, `reduced-motion-*.png` |
| Adapted sizes/themes | Preserve hierarchy, reachability and safe-area/keyboard clearance. Grow/wrap Return and sheets at 200% text; scroll instead of shrinking targets. Review dark Hub and unpictured accessibility variants as extensions; pictured dark workspace overlays do not establish a photographed dark Hub. | `small-*.png`, `landscape-*.png`, `large-text-320x740-*.png`, `large-text-844x390-*.png`, `dark-*.png` |

## Continuity and review discipline

Use scoped Hub and workspace roots in one document. Scope styles, DOM queries,
events, focus and URL/service context; retain existing workspace state owners.
An inactive root is not focusable or a competing shortcut target, but ordinary
Hub navigation does not dispose the workspace or abort ongoing client work.
Keeping an iframe alive, serializing File attachments into storage, or drawing a
fake terminal is not a substitute. The full continuity scenarios are in
`screen-map.md`.

The screenshot set does not directly picture login, empty dashboard, full device
or security details, most credential types, or full onboarding/error workflows.
Design these as coherent extensions of the above grammar and present them for
review; do not claim they were already approved. Keep screenshot/interaction
evidence, named deviations and unresolved decisions in the review handoff.
Automatic checks are supporting evidence only. The phase ends at **explicit user
visual and interaction approval**, not at a green test suite, and live integration
requires the subsequent authorized work.
