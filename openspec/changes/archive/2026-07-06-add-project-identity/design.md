# Design — add-project-identity

## Context

The client already has everything it needs at boot: `GET /api/state` returns `StatePayload.roots: RootGroup[]`, and each `RootGroup` carries `id`, `label` (basename of the root), and `path` (`src/shared/types.ts`). `src/shell/boot.ts` fetches the payload and `src/shell/events.ts` applies subsequent ones over SSE. The page title is a hardcoded `<title>uatu</title>` in `src/index.html`, no favicon link exists (the browser 404s on `/favicon.ico`), and the sidebar brand block (`.brand` in `index.html`) holds the logo, the `UatuCode` wordmark, and the connection-state chip.

## Goals / Non-Goals

**Goals:**

- A user with five uatu tabs can pick the right one from the tab strip alone (title text + favicon color).
- Inside the app, a fixed ambient marker answers "which project is this?" without reading the document tree.
- Identity is stable: same project → same label and same hue across restarts and machines-with-same-paths; different projects → almost always different hues.
- Zero configuration and zero server changes.

**Non-Goals:**

- PWA manifest naming/icons stay static (`uatu`). Templating the manifest per project is server-side work with install-cache subtleties; if multi-instance PWA installs become a real workflow, that's its own change.
- No user-configurable label or color override in `.uatu.json` (add later if the derived label ever proves wrong in practice).
- No per-document title (`<doc> — <project> — uatu`); tab width makes long titles counterproductive, and the issues are about *project* identity.

## Decisions

### D1: Label rule — first root's label, `+N` suffix for multi-root

Single root → `roots[0].label`. Multiple roots → `` `${roots[0].label} +${roots.length - 1}` `` (e.g. `uatu +2`). Empty roots → fall back to plain `uatu` with no marker. The first root is the natural "primary" (it's the order the user passed on the CLI), and `+N` is honest about there being more without burning tab-title width. The marker's tooltip lists every root's full `path` so the truth is one hover away.

Alternative rejected: joining all labels (`docs · api · web`) — unreadable at tab width for exactly the sessions that need identity most.

### D2: Hue from a stable hash of root paths, applied to favicon and marker

`hue = fnv1a(sortedRootPaths.join("\n")) % 360`. Paths, not labels: two projects named `docs` must not collide, and `RootGroup.path` is already in the payload. Sorted so root order on the CLI doesn't change the color. FNV-1a because it's a five-line pure function — no dependency.

The same hue drives both the favicon tint and the sidebar marker badge, so the color the user learns in the tab strip is the color they see in the app. Fixed saturation/lightness (`hsl(hue, 60%, 45%)` with white text) keeps every hue legible on both light and dark tab strips; only the hue varies.

Alternative rejected: hashing `rootId` — it's stable per session but derived server-side; paths are the user-meaningful identity and survive any future id-scheme change.

### D3: Favicon as a dynamic SVG data-URL link element

`applyProjectIdentity` builds a small SVG — rounded square filled with the identity hue, the label's first character in white, centered — encodes it as a `data:image/svg+xml` URL, and creates-or-updates a `<link rel="icon" type="image/svg+xml">` in `<head>`. No new HTTP route, no asset pipeline, works offline, and updating the href on re-apply is idempotent. SVG favicons are supported by every browser uatu targets (Chromium, Firefox, Safari 17+); browsers without support keep today's behavior (no favicon), which is a graceful floor.

The letter matters: color alone fails for color-blind users and for adjacent hues; letter + color covers both.

### D4: One entry point, applied on every state payload

A single `applyProjectIdentity(roots: RootGroup[])` in `src/shell/identity.ts` sets title, favicon, and marker together, and is called wherever a state payload is applied (initial boot and SSE refreshes). Roots can change while the server runs (scope changes); re-deriving on every payload is cheap, idempotent, and removes any "which callsite forgot to update the favicon" class of bug. Pure derivation helpers (`projectLabel`, `identityHue`, `faviconSvg`, `pageTitle`) are exported for unit tests; only `applyProjectIdentity` touches the DOM.

### D5: Marker placement — the repository name in the Change Overview pane

First iteration put a label badge in the sidebar brand block, but review feedback pointed out the Change Overview pane already names each repository — adding a second label to the chrome duplicates information. Instead, the existing repository name in Change Overview *becomes* the marker: rendered as a badge with the identity hue (slightly larger than a chip), tooltip listing that repository's watched root paths. The badge hue hashes the repository's watched roots' paths — the same inputs as the favicon — so the common single-repo session shows exactly the favicon color in the pane. Multi-repo sessions get one badge per repository (each hued by its own roots) while the favicon carries the combined session hash; the tab color then identifies the session and the badges identify the repositories within it.

## Risks / Trade-offs

- **[Hue collisions between two projects]** → 360 hues, FNV-1a spread; with a handful of simultaneous projects collisions are unlikely, and the label text and letter disambiguate when they happen. Accepted.
- **[Label ambiguity: two projects with the same basename]** → titles match but favicon hues differ (path-based hash); tooltip shows full paths. Accepted — this is exactly why D2 hashes paths.
- **[SVG favicon unsupported in old Safari]** → no favicon, which is today's behavior. No regression.
- **[`+N` hides the other roots]** → tooltip lists all paths; the document tree itself shows every root section. Accepted.

## Open Questions

None.
