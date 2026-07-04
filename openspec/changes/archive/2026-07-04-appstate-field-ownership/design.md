# Design — appstate-field-ownership

## Context

`appState` (16 fields in `src/shell/state.ts`) is mutated directly by 14 modules across `shell/`, `preview/`, and `sidebar/` at ~82 sites. state.ts's own header comment calls itself a "minimum viable extraction". The one disciplined region — `followEnabled`/`selectedId` under follow-mode's four rules — is also the app's most reliable behavior, and its `withProgrammaticUpdate` guard fixed the project's worst historical flake. This change extends that single-writer shape to every field.

## Goals / Non-Goals

**Goals:**
- One owning module per field; direct assignment confined to the owner.
- Named mutators as the cross-module mutation API; reads stay unrestricted.
- Preference persistence fused into the mutator so assign-and-persist can't drift.
- Unit tests on mutators, improving `shell/`/`preview/` coverage as a side effect.

**Non-Goals:**
- No state framework, signals, observers, or re-render scheduling changes — render calls stay where they are today.
- No change to what is persisted or to any user-visible behavior.
- No relocation of `appState` itself; state.ts stays the single container.
- Not untangling the wider `shell`/`preview`/`sidebar` import triangle beyond what mutator extraction naturally improves.

## Decisions

- **Mutators live with their feature owners, not in state.ts.** Centralizing 16 fields' logic in state.ts would recreate a god-file and force state.ts to import from feature folders (inverting the dependency direction). The owner module already holds the related rendering/persistence logic; the mutator sits next to it. state.ts stays import-leaf.
- **Ownership follows "who renders it / who persists it today":** follow (`followEnabled`, `selectedId` — unchanged), SSE/boot (`roots`, `repositories`, `scope`, `staleHint`), preview (`previewMode`, `viewMode`, `viewLayout`, `splitRatio`, `diffStyle`, `wrap`), sidebar (`panes`, `filesPaneFilter`, `gitLogLimit`, `compareTarget`). Where two modules currently write the same field (e.g. boot and events both set `roots`), the module that handles ongoing updates owns it and the boot path calls the mutator.
- **Plain functions, not setters-on-an-object.** `setViewMode(mode)` reads better at call sites than `state.viewMode.set(mode)`, is tree-shakeable, and matches the existing follow-mode API shape (`setFollowEnabled` style).
- **Enforcement by convention plus a grep-shaped scenario, not tooling.** An ESLint-style rule isn't available (no linter in the repo); the spec scenario ("direct assignment only in the owner module") is checkable in review and by a trivial grep. Adding lint infrastructure is out of scope.
- **Incremental by field-group, not big-bang.** Each ownership group (preview prefs, sidebar prefs, SSE snapshot, follow) is an independent commit with its own tests, so the change can pause safely at any commit boundary.

## Risks / Trade-offs

- [Mutator indirection hides a re-render that used to sit next to the assignment] → Mutators only assign and persist; render calls stay at the call site unchanged in this pass. Moving render scheduling into mutators is explicitly deferred.
- [Two modules genuinely need to write one field (boot vs events)] → The ongoing-updates module owns it; the other becomes a caller. If a true dual-writer emerges, the field's owner exposes a second named mutator rather than reopening direct assignment.
- [Discipline decays without tooling] → The spec scenario makes it a review-checkable contract, and the ownership table in ARCHITECTURE.md keeps the map discoverable. If decay is observed later, a lint rule is the escalation path.
- [Large mechanical diff obscures a typo'd assignment] → Field-group commits plus mutator unit tests; the e2e suite covers the integrated behavior (follow-mode, url-routing, sidebar, wordwrap already have e2e files).

## Migration Plan

Independent of the other feedback changes; schedule last. One PR per field-group is acceptable if a single PR reviews poorly. Rollback is a revert per group; no persisted-data format changes.

## Open Questions

None — exact mutator names are an implementation detail bounded by the ownership map.
