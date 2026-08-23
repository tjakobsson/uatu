# Tasks: add chat image attachments

## 1. Pin the risky assumption first

- [x] 1.1 Verify against a real OpenCode 1.18.21 session that a v2 prompt with `files: [{uri: file://…}]` succeeds and that the stored user message echoes a `FilePart` whose `url` basename survives verbatim; record the observed echo shape as a comment on the normalization mapping — verified live (1.18.18 binary, pinned SDK): v2 projection echoes the uri verbatim; classic view rewrites to data: URLs; D5 updated accordingly
- [x] 1.2 Add the `attachments` field to the `OpenCodeProvider.prompt` input type (`{id, name, mimeType, absolutePath}[]`, provider-neutral) with doc comment stating the neutrality constraint

## 2. Attachment store (server)

- [x] 2.1 Create `src/chat/attachment-store.ts`: XDG state-root resolution (mirroring `src/hub/state-dir.ts`), per-workspace/per-conversation layout, server-issued uuid ids, owner-only file creation — layout simplified to flat per-workspace (design D3 updated)
- [x] 2.2 Implement intake validation in the store: magic-byte sniffing for PNG/JPEG/GIF/WebP, 10 MiB size cap, stored extension derived from sniffed type; reject everything else with typed errors
- [x] 2.3 Implement id-indexed lookup that never interprets client strings as paths; hostile ids (traversal, unknown) resolve to "not issued"
- [x] 2.4 Unit tests: store round-trip, sniffing accept/reject per format, size cap, hostile-id refusal, files land outside the watched roots used by tests

## 3. Wire: routes, schema, types

- [x] 3.1 Add `POST /api/chat/conversations/{id}/attachments` (multipart, one image per request) to `buildChatRoutes` in `src/server/routes.ts`, returning `{id, name, mimeType, sizeBytes}`; enforce auth like the other chat routes
- [x] 3.2 Add `GET /api/chat/attachments/{id}` serving stored bytes with correct content type and the conversation API's authorization
- [x] 3.3 Extend `ChatPromptRequest` with optional `attachments: [{id, name, mimeType, sizeBytes}]` — field allowlist in routes, `src/chat/validation.ts`, `src/chat/types.ts` (`UserMessageItem`, `QueuedMessage` gain `attachments`), and `api/openapi.yaml` (upload/serve endpoints + schema fields, `additionalProperties: false` preserved)
- [x] 3.4 Bump `WORKSPACE_API_REVISION` in `src/shared/version.ts`
- [x] 3.5 Route tests: upload happy path, oversize/wrong-type refusal with client-visible reason, unauthorized serve refused, hostile id refused, prompt with unknown attachment id refused

## 4. Adapter, provider, normalization

- [x] 4.1 Adapter (`src/chat/adapter.ts`): resolve prompt attachment ids through the store into provider attachments at dispatch; held messages carry attachment references and deliver them under the frozen configuration; removal of a held message drops its references
- [x] 4.2 `SdkV2Provider.prompt`: convert provider attachments to v2 `files: [{uri: pathToFileURL(...).href, name}]` (classic fallback: `FilePartInput` with mime/filename/url); declare the `"attachments"` capability in `describe()`
- [x] 4.3 Map model capabilities in `SdkV2Provider.listModels`: `ChatModel.imageInput` from `capabilities.input.image || capabilities.attachment`
- [x] 4.4 `src/chat/normalization.ts`: map echoed user-message `FilePart`s to `attachments` on `UserMessageItem` via the url-basename id (D5); unknown basename → placeholder attachment entry
- [x] 4.5 Extend the e2e fake OpenCode (`tests/e2e/chat-service.ts`) to accept prompt files and echo `FilePart`s like the real server
- [x] 4.6 Adapter/provider/normalization unit tests: dispatch conversion, queue hold/remove/deliver with attachments, echo mapping, placeholder path

## 5. Composer UI

- [x] 5.1 Composer markup and styles: attach button in the action rail (non-wrapping rule holds), hidden file input (`accept` limited to the four types), pending-attachment strip above the textarea with removable thumbnails (object URLs, revoked on removal/send)
- [x] 5.2 Upload-at-attach in `src/chat/client.ts` + `src/chat/ui.ts`: picker, paste (`clipboardData.files` filtered to images; text in the same paste still enters the draft), and dragover/drop handlers with drop-target highlight and stuck-highlight reset
- [x] 5.3 Intake bounds and errors: 8-per-message cap, unsupported-type and oversize refusals via the composer error line, draft and pending attachments untouched on refusal
- [x] 5.4 Gating: no intakes when the agent lacks `"attachments"`; visible-but-inactive attach control naming the model when `ChatModel.imageInput` is false, paste/drop refused with the same message; send path includes attachment ids; failure path restores text and attachments to the composer
- [x] 5.5 Touch mode check: attach button reachable and usable in the touch layout tabs — the control is a permanently visible rail button in the shared composer markup (no hover/keyboard dependency); verified visible in the demo screenshots

## 6. Timeline and queue rendering

- [x] 6.1 `src/chat/timeline-renderer.ts`: thumbnails (via `appUrl()`-built serve URLs) on user messages, optimistic drafts, and the queue dock; attachment names escaped; missing-bytes placeholder
- [x] 6.2 Replay: verify a reload re-renders thumbnails from normalized stored history with no client-side state — covered by the picker e2e (reload + naturalWidth assertion)

## 7. Verification

- [x] 7.1 Run the app (`bun run dev`) and demo the full flow — paste, drop, picker, remove, send, queue-while-running, reload — before the e2e pass — demoed via a scripted browser session against the e2e server with screenshots reviewed (pending strip, sent thumbnails, queued thumbnail, delivery)
- [x] 7.2 E2E tests in `tests/e2e/chat-attachments.e2e.ts`: picker upload + send + thumbnail render, paste and drop intakes, bound/type refusals, gating states, held message with attachments delivered after turn end, replay after reload, unauthorized serve
- [x] 7.3 Full `bun test` and `bun test:e2e` green; `openspec validate --strict` passes for this change — unit suite 2187 pass / 0 fail; e2e: every test green across two full runs (one pre-existing flaky watcher test failed once and passes in isolation); strict validation passes
