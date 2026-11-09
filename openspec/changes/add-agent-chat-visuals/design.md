# Design

## Context

See [proposal.md](proposal.md) for motivation and
[the capability delta](specs/chat-visuals/spec.md) for acceptance behavior.
The initial implementation was uncommitted on top of merge `331661b`, which
integrated upstream `71e4700`. The current integration base is upstream
`ab6f4c2` (latest rebase on 2026-11-09). Retrospective planning was approved on
2026-10-30; implementation presence still does not establish final acceptance.

The shared chat model owns presentation while native agent transcripts own
conversation history. Claude replaces streaming text items when durable
records arrive. HTML parsing can reorder elements through table repair.
Neither presentation order nor transient item IDs can identify immutable
captures. Existing static-file authority and brokered replay must remain intact.

## Goals / Non-Goals

**Goals:** keep visual extraction and rendering in agreement; isolate captured
assets from source files; preserve native transport identities; keep image
reads and retained rendering work bounded.

**Non-Goals:** a new agent sharing tool, mandatory skill, remote-image proxy,
arbitrary tool-result extraction, active SVG DOM, changes to upload formats,
or edits to repository/global agent configuration. This is not an OS sandbox.

## Decisions

### One prepared Markdown representation owns visual occurrences

`visual-markdown.ts` prepares sanitized HTML and visual inputs together.
Compiler-token origins are attached before HTML repair, then removed from
presentation attributes. Source-based occurrence keys survive reference
resolution and foster parenting; rendered indexes match the displayed order.
Fenced SVG source is collected before syntax highlighting, including whether
its closing fence has arrived.

Separate regex-only extraction was rejected: nested fences, references,
escaping, and HTML repair would disagree with rendering. The prepared-result
cache is bounded by entry count and estimated retained text size. Bounded
arbitrary-input property tests cover the complete chat output path, including
markup inserted after sanitization; current results are recorded in tasks.md.
Original image destinations are retained only in private tree metadata before
the shared sanitizer removes unsafe URL attributes, so refused references can
remain escaped text without granting fetching or navigation authority.

### Native logical identity survives completion and history reload

The shared service enriches assistant items without rewriting their native
timeline IDs. Claude normalization supplies internal symbol-keyed text-block
metadata derived from API message identity and text-block ordinal. The same
metadata is reconstructed from native history. Occurrence offsets are relative
to the originating text block. This metadata survives object spreads but is
not serialized into the closed wire schema.

Hashing only timeline item IDs was rejected because transient Claude IDs are
replaced at completion. Matching only image URLs was rejected because duplicate
references are distinct occurrences. Existing native IDs and event cursor
ordering remain authoritative for the client.

### Store complete immutable records outside watched roots

`VisualStore` scopes opaque IDs by workspace, conversation, native logical
message, and occurrence. A complete record stores capture metadata, preview
bytes, and original SVG source where applicable. Atomic no-overwrite publication
chooses the first complete winner across callers/processes. Pending missing-file
records allow one completion retry; terminal metadata prevents rereading
successful or refused occurrences. A source change under an existing key is
refused rather than silently replacing its capture.

Eight immutable slot files form a per-native-message admission ledger.
Atomic no-overwrite publication reserves each occurrence permanently, including
refusals; removal or changing DOM order cannot admit a ninth capture. Shared,
symbol-keyed native API message identity gives Claude and both OpenCode
generations one budget across their message's text parts. Native history
normalization reconstructs that identity without changing capture IDs or wire
fields. Wire indexes describe current rendered positions
and may exceed seven; the reference array itself remains bounded at eight.

Admission choices from intermediate unreleased test builds are not migrated.
Legacy-priority compatibility was explicitly removed on 2026-11-02.
Existing stored files, IDs, and bytes remain untouched and resolvable; an old
test conversation may show a different set of up to eight previews after
upgrading. The ledger begins on first processing by the new implementation.
Capture selection is a single pass that retains at most eight requests.

Directly displaying workspace paths was rejected because edits/deletions would
rewrite history. Each store admits at most four capture/resolve operations at
once. Assistant limits live in shared browser-safe visual policy rather than
borrowing user-upload limits. Snapshot retention currently has no quota or
garbage-collection policy; adding either is separate scope.

### Reuse file authority and isolate preview documents

The configured reader applies watched-root, deny, ignore, traversal, and
symlink checks, opens files without following the final symlink, rechecks file
identity, and performs a bounded read that refuses observed mutation. It does
not grant the agent new filesystem authority.

All original image elements are replaced before HTML reaches the browser.
External references remain inert until a user explicitly follows their link.
SVG validation deliberately supports a conservative self-contained subset;
unsupported SVG keeps its bounded original source but receives no preview.
Preview bytes are served as image documents with sandbox CSP and `nosniff`,
never inserted as live SVG markup. Source is served as plain text. Both routes
require normal workspace credentials and opaque issued IDs.

### Enrich native events without inventing sequence numbers

`MultiAgentChatService` enriches history and live updates using the same store.
Text deltas remain native deltas unless visual references change; that update
can use a full native-sequenced item replacement. Completion retries and
reconnect enrichment use the existing resync mechanism. Snapshot-seeded state
must not append replayed text twice. Captured bytes do not ride events; original
fenced SVG remains part of provider-authored Markdown.

### Keep visual interaction within the existing chat surface

The renderer generates opaque preview/source URLs and escaped controls.
`visual-ui.ts` loads original source lazily, copies only source text, and
handles fetch, clipboard, and browser-decoding failures. SVG-specific definite
wrapper widths prevent viewBox-only images collapsing to zero; raster images
retain natural sizing. The existing dialog provides enlargement. Existing
reading-anchor/follow-intent logic remains responsible for image layout changes.

The image-anchor tests also exposed a pre-existing touch interaction: blurring
the focused composer can move Latest before a pointer click completes. A
narrow correction and focused/unfocused pointer regressions were approved;
implementation and verification status are tracked separately in tasks.md.

### Inject guidance through native session context only

Claude receives presentation text through native `SessionStart` additional
context, preserving the native prompt on new and resumed queries. OpenCode
receives an instruction-file entry through the spawned child's inline config.
Its private per-service file is under the application's state directory and
is removed on disposal. Existing JSON/JSONC settings and instruction entries
are preserved. If inline configuration cannot be extended safely, or guidance
state cannot be written, a sanitized warning explains why native startup
continues without optional hints. Proven-dead app-owned guidance directories
are swept in bounded startup housekeeping; live and unknown owners are kept.
Global/repository instruction files and tool permissions are not changed.

## Risks / Trade-offs

- Conservative SVG support rejects some valid SVG → retain source and explain
  preview refusal; do not broaden resource access to improve compatibility.
- Native text identity or HTML-origin mistakes can recapture content → native
  completion/history and reordered-table regressions, plus independent review.
- Post-sanitization control markup adds an output safety boundary → bounded
  generated-input tests for hostile references, SVG source, and snapshot fields.
- Persistent snapshots can consume disk → retain the specified per-image and
  per-message bounds; disclose that no lifetime storage quota is introduced.
- Earlier checks used Bun 1.4.2 and client 2.0.28 → a scoped restore was approved
  on 2026-10-30. Task-local Bun 1.4.3 was release-digest verified,
  and a frozen install supplied client 2.1.2 without manifest/lockfile changes.
  Later runtime/dependency integration and renewed checks are recorded in
  tasks.md; global Bun remains unchanged.

## Migration Plan

1. Review and approve these retrospective artifacts before resuming code work.
2. Resolve remaining review findings and verify the integrated fixes against
   pinned upstream, including all new implementation files.
3. Keep workspace revision 37, web revision 4, API schema/examples, and migration
   notes aligned. Strict revision-36 validators must be regenerated for the
   optional assistant `visuals` field; the Hub revision remains 14.
4. Run relevant unit, generated-input, contract, build, and browser checks;
   report full-suite or live-agent limitations separately.
5. Synchronize the new capability into main specs and archive the completed
   change before final merge, following the repository workflow.

Deploy server and bundled assets together. Roll back by deploying the prior
complete build, not by mixing old strict validators with new payloads.
Keep visual state intact during rollback; it is app-owned state outside the
repository. No publication or test-hub redeployment is part of this checkpoint.
