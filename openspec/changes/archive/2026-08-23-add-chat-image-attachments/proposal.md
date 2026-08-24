# Add chat image attachments

## Why

Chat can only carry text today, so anything visual — a screenshot of a rendering
bug, a design mock, a photo of a whiteboard — has to be described in words even
though OpenCode already accepts image attachments on a prompt and reports, per
model, whether the model can see them. The composer should let users attach
images the way every modern chat surface does: paste from the clipboard, drop
onto the composer, or pick from a file dialog.

## What Changes

- The chat composer accepts image attachments (PNG, JPEG, GIF, WebP — the set
  OpenCode supports) via clipboard paste, drag-and-drop, and an explicit
  attach button backed by a file picker. Pending attachments are presented as
  removable thumbnails before send.
- Attachments are uploaded once to a uatu-owned attachment store (outside the
  watched workspace, so the watcher, git sweep, and ignore engine never see
  them) and referenced by id thereafter; prompt submissions, the held-message
  queue, and the event stream carry references, never image bytes.
- The OpenCode hand-off passes stored attachments as `file:` URLs on the
  prompt (uatu and the OpenCode server share a filesystem), leaning on
  OpenCode's server-side image resizing rather than reimplementing it.
- Attach affordances are capability-gated: the agent must declare an
  attachments capability, and the selected model must report image input
  support. Attachments echoed back by OpenCode are normalized and rendered in
  the timeline (and survive replay) via an authenticated attachment route.
- The workspace API grows an upload endpoint and an attachment-serving
  endpoint; the prompt request and user-message/queued-message shapes grow an
  attachments field (additive; API revision bump).

Out of scope for this change: non-image file types, client-side image
compression (OpenCode resizes server-side; revisit if real usage hits the
upload cap), attaching workspace files by path (`file:` URLs with line ranges
— a separate feature that can ride the sidebar tree later), and persisting
pending attachments across page reloads with the text draft.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: new requirements for attachment intake at the composer
  (paste / drop / picker, removable pending thumbnails, capability- and
  model-gated), attachment upload and storage boundaries, attachment delivery
  to the agent, timeline rendering and replay of attached images, and queue
  interaction (held messages keep their attachments; the model-switch edge is
  handled explicitly). The existing composer action-rail and capability-gating
  requirements are honored, not modified.

## Impact

- **Client**: `src/chat/ui.ts` (paste/drop/picker handlers, pending-attachment
  strip, gating), `src/chat/client.ts` (upload + prompt payload),
  `src/chat/timeline-renderer.ts` (thumbnails in drafts, queue dock, and user
  messages), `src/chat/types.ts` + `src/chat/validation.ts` (wire shapes),
  `src/index.html` + `src/styles.css` (composer markup).
- **Server**: new attachment store module under `src/chat/` (XDG state root,
  mirroring `src/hub/state-dir.ts`), new routes in `src/server/routes.ts`
  (multipart upload, authenticated attachment serving), `api/openapi.yaml`
  additions, `WORKSPACE_API_REVISION` bump in `src/shared/version.ts`.
- **Provider seam**: `src/chat/provider.ts` prompt input grows a neutral
  attachments field; the `file:`-URL conversion lives inside
  `src/chat/sdk-v2-provider.ts`; `src/chat/normalization.ts` maps echoed
  OpenCode file parts into user-message items; `src/chat/adapter.ts` holds
  attachment references on queued messages. Shapes stay provider-neutral so a
  future second agent reuses the store, routes, and UI unchanged.
- **Dependencies**: none added. Uses the pinned `@opencode-ai/sdk` 1.18.21
  surface (`files` on the v2 prompt input, model `capabilities.input.image` /
  `capabilities.attachment` from provider listing).
- **Interaction with pending change**: builds on the delivered
  `own-chat-message-queue` behavior (held messages, queue dock); this change
  adds attachment references to held messages but does not alter queue
  semantics.
