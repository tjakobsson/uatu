## Context

`add-find-in-surface` gives uatu find-in-document and, as a by-product, a
highlight-and-reveal primitive that works over the preview without mutating it.
This change spends that primitive on the second half of the shortcut pair: ⇧⌘F,
searching every watched document rather than the open one.

The server side is unusually cheap because the work is already done.
`getSession().getRoots()` returns `RootGroup[]` whose `docs` carry an absolute
path, a relative path, and a `kind` that is already `binary` for anything not
worth reading — with `.gitignore` and `.uatu.json` exclusions applied by the
ignore engine and the whole thing kept current by the watcher. There is no index
to build, no walker to write, and no ignore logic to duplicate. Search is a read
and a match over a list that already exists.

The client side is similarly pre-shaped: the sidebar is a pane stack with
show/hide/collapse/resize and a panels menu, so a Search pane is a new tenant
rather than new chrome.

The uncomfortable part is neither of those. It is that the corpus is *source*
text while the reading surface is *rendered*, and those disagree about roughly
every match inside link syntax, heading markers, and fenced blocks.

## Goals / Non-Goals

**Goals:**

- Answer "where else does this appear" without leaving the reading surface.
- Reuse `add-find-in-surface`'s highlighting rather than growing a second path.
- Stay responsive on a watched folder that is an entire repository, not a docs
  tree.
- Make scope legible: never silently return nothing because a scope was narrow.

**Non-Goals:**

- Replace across files. Searching is a reading act; uatu does not edit.
- Search history, saved searches, or a results-as-document view.
- Searching file names — the Files pane filter already does that, and merging
  the two would make both worse.
- A persistent content index. The corpus is small, local, and already in memory;
  an index would add invalidation bugs to buy latency nobody is short of.

## Decisions

### 1. Search the in-memory root groups, not the filesystem

`/api/search` iterates `getSession().getRoots()`, skips `kind === "binary"`, and
reads each remaining file. Ignore rules, scope, and freshness all come along for
free because they are properties of the list, not of the search.

*Why not shell out to ripgrep?* uatu ships as a single-file Bun binary with no
external runtime dependencies, and `rg` is not guaranteed present on any of the
platforms uatu supports. Making search quietly better on machines that happen to
have ripgrep — and worse everywhere else — is the kind of platform-conditional
behavior this project avoids.

*Why not build an index?* The corpus is bounded by what the user chose to watch,
files are local, and Bun's reads are fast. An index would trade a latency problem
nobody has for an invalidation problem everybody eventually has.

### 2. Results stream; they are not collected and returned

The route responds progressively — each document's hits are emitted as they are
found, and the pane renders them as they arrive. On a docs tree this is
imperceptible; on a repository it is the difference between a pane that fills
and a pane that hangs.

*Alternative considered:* a plain JSON array after a full sweep. Simpler, and
fine at small scale, but it makes the worst case feel broken rather than slow.
uatu already runs an SSE stream for live reload, so streaming is an established
shape in this codebase rather than a new one.

### 3. Bounded work, and truncation is disclosed

A minimum query length, a debounce on input, a cap on total matches, and a
per-document time bound on regex evaluation. When the cap trips, the pane says
so.

The point of the disclosure is that a silently truncated result list reads as
"that's everywhere it appears" — which is exactly the wrong conclusion for a
reviewer to draw. The regex time bound exists because the pattern comes from the
user and runs on the user's own server: a catastrophic backtrack is not a
security problem here, but hanging the app you are reading in is still a bug.

### 4. Results land in Rendered view, falling back to Source

Activating a result opens the document rendered and reveals the match. If the
matched text cannot be located in the rendered DOM, the view flips to Source,
where it always can be.

*Why not always Source?* It is honest and always lands, but it answers a question
about a document by showing a file. Most matches — ordinary prose — are perfectly
visible rendered, and forcing everyone into raw text to accommodate the minority
is the wrong default for a reading tool.

*Why not split view?* It was genuinely tempting: the source pane carries the match
and the rendered pane carries the context, and it is uatu's own answer rather
than one borrowed from another editor. It was rejected as a *default* because it
is a heavy landing for every single result click and it presumes the user wants
both. It remains the obvious thing to offer later as a modifier-click.

The probe is the same text index preview find already builds, so "is this match
present in the rendered view" costs one index the feature would build anyway.

### 5. Scope is respected and named

Search runs over the scoped roots, because `getRoots()` already returns them and
because scope is a deliberate act the user performed. But a scope of one file
makes search look broken, so the pane names the scope in effect and offers a
one-click widening.

*Alternative considered:* ignoring scope entirely, on the grounds that ⇧⌘F is
"global". Rejected — it would mean the sidebar shows one corpus and search
silently uses another, which is worse than either behavior on its own.

### 6. The Search pane is a pane-stack tenant

No new chrome: it registers alongside Change Overview, Files, Git Log, and
Selection Inspector, inheriting collapse, hide, resize, persistence, and the
panels menu. ⇧⌘F reveals and expands it if hidden.

*Alternative considered:* a full-width command-palette overlay. Better for a
transient query, worse for the actual use — results you keep coming back to while
reading, which wants a pane you can leave open beside the document.

### 7. Results go stale rather than lying

Line numbers are captured at match time and files change underneath them. When a
file with visible results changes, the pane marks the results as possibly out of
date and offers to re-run; activating a result whose text is gone opens the
document without a highlight rather than jumping somewhere arbitrary.

*Why not auto-re-run on every file event?* In a watched repository that is a query
storm, and it would make results jump under the user's cursor while they are
reading them.

## Risks / Trade-offs

- **The watched folder may be a whole repository** → Debounce, minimum query
  length, streaming, and a match cap. The corpus already excludes binaries and
  ignored paths, which removes most of the volume before matching starts.
- **User-supplied regex on the user's own server** → Per-document time bound;
  abandon and report rather than block the sweep.
- **Source-vs-rendered mismatch** → The fallback in Decision 4 is the mitigation,
  and it is the change's main UX gamble. If the flip proves disorienting in use,
  the alternatives in that decision are the ladder to climb.
- **Depends on an unlanded change** → This change should not be applied before
  `add-find-in-surface`. Its highlight entry point is specified there as a delta
  so the dependency is explicit rather than implied.
- **Two shortcut owners for one mental model** → ⌘F is surface-routed and ⇧⌘F is
  not. That asymmetry is deliberate and matches VS Code, but it needs to be
  stated in the docs or it reads as an inconsistency.

## Migration Plan

Additive: one new route, one new sidebar pane, one new shortcut. No persisted
format changes beyond the pane's own visibility and height, which use the
existing pane persistence. Rollback is reverting the change.

Sequencing:

1. `/api/search` with streaming, caps, and scope handling — testable without UI.
2. Search pane shell and result rendering.
3. ⇧⌘F binding and pane reveal.
4. Open-and-jump, including the rendered-presence probe and Source fallback.
5. Staleness handling.

Steps 1–3 give a usable read-only search; step 4 is what makes it worth having.

## Open Questions

- What are the right numbers — minimum query length, debounce interval, match
  cap, regex time bound? Best chosen against a real repository during
  implementation rather than guessed here.
- Should results collapse per file by default, or list flat? Depends on typical
  result density, which is not known yet.
- Should a modifier-click on a result open the split view described in Decision
  4? Cheap to add once the landing logic exists, but only worth it if the
  Rendered/Source flip turns out to be the annoyance it might be.
