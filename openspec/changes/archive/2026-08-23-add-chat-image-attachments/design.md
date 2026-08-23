# Design: add chat image attachments

## Context

See `proposal.md` for motivation. Constraints that shape the approach:

- The browser speaks only uatu's normalized wire (`/api/chat/*`); OpenCode is
  reached exclusively through `OpenCodeProvider` (`src/chat/provider.ts`).
  uatu and the spawned OpenCode server share a filesystem and a working
  directory (`src/chat/opencode-service.ts`).
- The pinned `@opencode-ai/sdk` 1.18.21 already carries the needed surface:
  v2 `PromptInput.files` (`{uri, name?}` — `file:` or `data:` URIs), echoed
  `FilePart`s in stored messages, and per-model
  `capabilities.attachment` / `capabilities.input.image` from
  `provider.list()`. OpenCode resizes images server-side (2000px /
  ~5 MiB base64 budget by default) and enforces a 20 MiB decoded cap per item.
- The held-message queue (`own-chat-message-queue`, delivered but not yet
  archived) freezes model/mode/variant per held message and replays queue
  state to every client; whatever a message carries must be cheap to hold and
  to broadcast.
- `ChatPromptRequest` has a strict field allowlist, a byte cap, and
  `additionalProperties: false` in `api/openapi.yaml`; wire changes bump
  `WORKSPACE_API_REVISION`.
- A second, non-OpenCode agent is on the roadmap. Everything that is not
  inherently OpenCode-specific must sit on the uatu side of the provider seam.
- Prior art studied: T3 Code (pingdotgg/t3code) ships the same feature
  provider-generically; its load-bearing choices (upload-and-reference,
  server-side store, `file:` URL hand-off to OpenCode, static caps) inform
  the decisions below.

## Goals / Non-Goals

**Goals:**
- Image attachments flow browser → uatu store → OpenCode with image bytes
  crossing each boundary exactly once.
- Every new shape (store, routes, wire fields, provider input) is
  provider-neutral; only `SdkV2Provider` knows OpenCode's attachment format.
- The queue, replay, and failure paths treat an attachment-bearing message
  exactly like a text message plus references.

**Non-Goals:**
- No client-side image re-encoding or resizing (OpenCode owns scaling; we do
  not duplicate what upstream fixes on their end).
- No attachment garbage collection in v1 (bounded uploads; see Open
  Questions).
- No non-image types, no workspace-file (`file:` path) attachment UX, no
  draft persistence of pending attachments across reloads.

## Decisions

### D1: Upload-and-reference, not inline data URLs

Attachments upload once to a uatu-owned store and are referenced by id in the
prompt request, held queue, projections, and events.

- Inline `data:` URIs (the alternative) would work end-to-end with no new
  routes — OpenCode accepts them — but the base64 would inflate
  `CHAT_PROMPT_BYTES`, sit in `heldQueues` for the lifetime of a held
  message, and come back on every replay: OpenCode echoes `FilePart`s, so an
  inlined image returns through `normalization.ts` and the SSE stream to
  every client, repeatedly. References keep all of those paths byte-free.
- T3 Code independently landed on the same shape across five providers.

### D2: Multipart upload endpoint; serve route under the conversation API

`POST /api/chat/conversations/{id}/attachments` accepts multipart form data
(one image per request), validates type and size, stores the bytes, and
returns `{id, name, mimeType, sizeBytes}`. `GET
/api/chat/attachments/{id}` serves stored bytes with the same authorization
the rest of `/api/chat/*` requires.

- Base64-in-JSON (T3's transport) inflates every upload by a third for no
  benefit; the hub SSH-key import already establishes the multipart pattern
  in this codebase.
- The serve route exists because replayed clients and late joiners need the
  thumbnails, and `file:` URLs echoed by OpenCode are meaningless to a
  browser. Client URLs go through `appUrl()` per the base-path discipline.
- Server-side validation sniffs magic bytes for the four supported formats
  rather than trusting the client mime type; the stored extension derives
  from the sniffed type.

### D3: Store lives under the XDG state root, keyed by issued ids

`~/.local/state/uatu/attachments/<workspace-key>/<uuid>.<ext>` (XDG
resolution mirroring `src/hub/state-dir.ts` / `debug/cache.ts`; flat per
workspace — the serve route resolves by id alone, and per-conversation
subdirectories would force an id→conversation index for no v1 benefit). The
server issues the uuid and the filesystem is the index: a client-supplied
identifier is matched against the strict uuid pattern before any path is
formed, never interpreted as a path (spec: hostile identifiers are refused
without filesystem interpretation).

- Outside every watched root by construction, so the watcher, git sweep,
  search, and ignore engine never see attachment bytes (T3's store makes the
  same guarantee; their in-workspace alternative would pollute `git status`).
- Survives uatu restarts, which replay needs.

### D4: Provider seam carries neutral references; `file:` URLs are private to SdkV2Provider

`OpenCodeProvider.prompt` input grows
`attachments?: {id, name, mimeType, absolutePath}[]` (resolved by the
adapter from the store). `SdkV2Provider` converts each to
`files: [{uri: pathToFileURL(absolutePath).href, name}]` on the v2 prompt
(classic fallback: `FilePartInput {type:"file", mime, filename, url}`).

- The conversion is three lines and inherently OpenCode-shaped; a future
  agent (e.g. Claude Code wanting base64 blocks) implements its own inside
  its provider. Store, routes, wire, and UI stay untouched for agent #2.
- `file:` over `data:` at this boundary because the processes share a disk:
  no base64 inflation, and OpenCode's stored `FilePart` then carries a path,
  not megabytes, which keeps replayed message payloads small (D5).

### D5: Replay linkage via the issued id in the echoed `file:` URI

**Verified against a live OpenCode server (1.18.18 local, SDK pinned
1.18.21) before implementation:** a v2 prompt with
`files: [{uri: "file://…", name}]` is admitted with the mime inferred, and
the v2 *projected* user message (`v2.session.messages` — the listing
`SdkV2Provider.allMessages` replays from) echoes
`files: [{uri, mime, name}]` with the `file:` URI **verbatim**. The classic
parts view instead rewrites the url into an inline `data:` URL (only
`filename` survives there), so the linkage keys off the v2 `files` uri, not
classic part urls.

`normalization.ts` maps the v2 user message's `files` into
`UserMessageItem.attachments`: the uri basename (the issued uuid) is parsed
back to the attachment id, which the client turns into the serve-route URL;
`name` and `mime` ride along for display.

**Durable-store amendment (verified against a live session after a real
turn):** the verbatim-uri echo holds only for the serving process's
in-memory projection. Once a turn runs and the session restarts, replay
comes from the classic durable store, where the file part is rewritten to an
inline `data:` URL — but OpenCode also stores a `synthetic: true` text
caption beside it ("Called the Read tool with {filePath: ...}") whose path
basename is the issued uuid. Normalization therefore (a) filters synthetic
captions out of the user's text — they are addressed to the model, not
words the user typed — and (b) recovers attachment ids by pairing captions
with file parts in order. A file part with neither a parseable uri nor a
caption yields the spec'd placeholder — projections carry references, never
bytes, so the stored base64 is deliberately not passed through.

- Alternative — a server-side map from OpenCode part ids to attachment ids —
  adds persistent bookkeeping for the same result; the uri we control
  already *is* the key.
- Provider-side model failures on image-bearing prompts surface as an
  assistant message with `finish: "error"` (also observed live), which the
  existing failure presentation already renders.

### D6: Gating rides existing mechanisms; the model edge is explicit

`ChatAgent` capabilities gain `"attachments"` (declared by
`SdkV2Provider.describe()`, one key per the established rule). `ChatModel`
gains `imageInput: boolean` mapped from `capabilities.input.image ||
capabilities.attachment`. UI behavior per the spec: capability undeclared →
no intakes at all; capability declared but selected model lacks image input →
attach control visible-but-inactive naming the model, paste/drop refused with
the same explanation. Held messages are already frozen; delivery never
re-checks the composer's current model.

- Visible-but-inactive (not hidden) for the model case deliberately diverges
  from the capability rule's absence principle: model choice is a
  per-conversation toggle the user flips constantly; a control that appears
  and disappears with it would be undiscoverable. T3's static mime allowlist
  with no model gating produces exactly the confusing provider-side failures
  we're avoiding (their issue #20802).

### D7: Static bounds: 8 attachments per message, 10 MiB per attachment

Constants beside the existing chat limits, enforced at intake (client) and
upload (server). 10 MiB sits safely under OpenCode's 20 MiB decoded cap
while leaving room for its resize budget; 8 matches T3's field-tested limit.
Oversize intake fails with the spec'd visible explanation — no client-side
compression ladder in v1.

## Risks / Trade-offs

- [OpenCode echo shape drifts — `FilePart.url` rewritten or absent on
  replay] → D5's placeholder degradation keeps rendering correct; an
  integration test against the pinned SDK pins the assumption; the session
  rule "check upstream docs before building around their fixes" applies when
  bumping the SDK.
- [Multipart handling in `Bun.serve` routes is new for `/api/chat/*`] → the
  hub SSH-key import is the in-repo precedent; e2e covers a real browser
  `FormData` upload.
- [The e2e fake OpenCode (`tests/e2e/chat-service.ts`) knows nothing of file
  parts] → extend the fake alongside the provider work, mirroring how the
  queue change extended it.
- [Clipboard/drag APIs differ across engines (Safari/iOS paste of images is
  historically quirky; T3 hit exactly this on mobile Chrome, their #2803)] →
  the picker button is the always-works fallback and is spec-required to be
  visible; e2e exercises paste and drop via CDP where supported, picker
  everywhere.
- [Unbounded store growth without GC] → bounded per message (8 × 10 MiB) and
  per conversation in practice; accepted for v1, revisited in Open Questions.
- [A second agent may want bytes, not paths] → the provider input carries
  `absolutePath` *and* identity/mime; a future provider can read the file and
  re-encode however it needs without touching the seam.

## Migration Plan

Purely additive: new routes, new optional wire fields, `WORKSPACE_API_REVISION`
bump (the existing freshness handshake already forces stale clients to
reload). No data migration; rollback is reverting the code — orphaned files
under the attachment store are inert and deletable.

## Open Questions

- Attachment retention/GC (delete with conversation? age out?) — deferrable:
  the spec's missing-bytes placeholder already defines behavior after any
  future cleanup, so a GC policy can land as its own small change.
- Whether pending (not yet sent) attachments should join the persisted
  composer draft — deferred with the draft-persistence non-goal; the spec is
  silent on reload of *pending* state, so adding it later is additive.
