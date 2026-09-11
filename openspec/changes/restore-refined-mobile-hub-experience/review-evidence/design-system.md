# Uatu Web UI design system — review candidate

The user approved consolidating the mobile Hub into a small, consistent,
Apple-inspired Web design system rather than continuing screen-by-screen patches.

The latest extension is shared **primary/secondary/destructive button hierarchy**
and **composed empty states**, used by actual Hub flows and the reference catalog.
See [preview-refinement/verification.md](preview-refinement/verification.md) for
current evidence and limits; the read-only picker remains separate from management.

## Use it

- Interactive reference: **`/review/design-system`**
- Hosted usage guide: **`/review/design-system/guide`**
- Source guide: `design/hub-mobile/design-system.md`
- Product primitives: `src/hub/mobile/design-system.ts`
- Semantic theme: `src/hub/mobile/tokens.css`
- Authoritative recipes: `src/hub/mobile/styles.css`

The reference uses the actual product modules and styles. It is a separately
bundled test-owned page, not a product Settings destination. Examples act locally;
they do not mutate Hub state. Its advisory uses a unique ephemeral identity, not
the reviewer's stored dismissal. Use dummy values only.

## What was consolidated

- One implementation of sections/counts, supporting text, commands, object and
  Settings navigation, fields, switches, one-of-many choices and readonly facts.
  Actual overview and domain callers use it; compatibility exports do not copy it.
- Semantic colors for actions versus selection, values versus supporting text,
  fields, feedback, switches and materials. Dark/contrast/transparency adaptations
  remain explicit, and switches retain their non-color state cues.
- A common 11/13/15/17/26/34px text hierarchy, rem-based scaling, spacing and radius
  roles, and 44px minimum target. Measured keyboard/dock/prompt layout remains with
  its existing owner, not theme constants.
- Duplicate stylesheet overrides and unused old recipes removed. Task headings
  no longer override section captions inside editor content. Return identity uses
  the control role rather than shrinking into secondary text.
- Navigation has disclosures; immediate commands do not. The shared list primitive
  no longer offers a hidden More shortcut. Boolean switches and radio selections
  remain drafts; rendering performs no writes, focus changes or backend work.
- Full-page editors and centered confirmations still use the existing TaskView,
  lifecycle/history and operation guards. No new generic renderer framework was
  introduced, and workspace interiors/desktop were not redesigned.

## Identity

Product frontend:
`sha256:49845329baf12c14a8da54b584cfb43c3f6c8152189a10adda6c0dfcbbd7c239`

Independent reference build (including the usage guide):
`sha256:3f0423af7bc88fb972af6e0553d8db50ec8fecc33c2f77489acb668e1d173a22`

The reference manifest at `/review/design-system/manifest.json` reports its own
identity. It does not alter the workspace asset fingerprint or imply approval.
Only explicit built asset names and the fixed guide are served; there is no
directory listing, source-map exposure or request-derived filesystem read.

## Verification

- Focused product/review suite: **393 passed, 0 failed; 4851 assertions**.
- Product and review-runtime TypeScript checks: **passed**.
- Tests enforce shared implementation identity, escaping, distinct semantic
  roles, native switch/radio drafts, token completeness, root scoping, one base
  recipe per selector and preservation of measured-layout ownership.
- Reference build/HTTP tests verify canonical routing, exact asset maps,
  host/origin/CSP protections, no backend mutation imports, independent identity
  and unchanged workspace version when reference assets vary.
- The latest Chromium reference run passed **3/3 tests**, covering command fills,
  pressed/focus/minimum-target states, composed empty/loading/error examples, the actual
  picker and navigation-as-detail, full-page review/editor, centered removal
  confirmation, focus/Escape, local pending/error, dismissal isolation and
  responsive/200% text checks. An earlier page-creation timeout is historical;
  this targeted pass does not complete the broader cross-engine application gate.
- Representative computed-style tests passed fields, switch geometry/state,
  17px values, 26px editor title, full-page radius, dark mode and accessibility
  alternatives. No before/after pixel-equivalence or approved-golden claim.

Current complete cross-engine, physical iOS keyboard/VoiceOver and historical
interior proof remain open under the existing acceptance gates. This is not
native UIKit/SF Symbols or Apple certification. No dependency, live backend
integration, new commit/push, spec sync or archive was performed in this pass.
