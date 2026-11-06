## Why

Users need to find recently updated files and preview audio and video quickly, including generated or Gitignored media. The current tree obscures recent disk writes, hides many generated files, and requires repeated Files/Preview navigation without offering media playback.

## What Changes

- Phase 1: add a flat, newest-first Recent view beside All and Changed, using filesystem write time rather than Git history or last-opened time. Show filenames, containing paths, and relative ages, and preserve touch targets, focus, and scroll during live updates.
- Simplify the Files header to one quiet count of the current result set. Remove the binary subcount and the filtered-versus-total wording. Remember the Files view per user and workspace.
- Use Pierre Trees' row decorations for quiet recency information in the normal tree. Keep the hierarchy alphabetically ordered and preserve its existing selection and expansion behavior.
- Phase 2: offer Show ignored files in the Files options, enabled by default when no explicit preference or legacy project setting exists. Saved personal visibility wins, then --no-gitignore shows, otherwise any watched root explicitly requesting respectGitignore=true initially hides ignored files. Use Pierre's muted ignored-file styling and the same treatment in Recent, without a repeated visible ignored-status label.
- **BREAKING**: Git-ignore rules become browsing visibility rather than an implicit server exposure boundary. Index otherwise permitted ignored files once, keep explicit Uatu excludes authoritative, and migrate existing ignore controls to initial-visibility defaults. Add narrow project configuration for generated output below normally excluded build/dist folders.
- Phase 3: deliver media through authenticated, revision-bound, range-capable HTTP requests separate from document JSON and the shared live stream. Preserve streaming backpressure and cancellation through the Hub.
- Phase 4: add audio/video previews, Audio/Video file filters, and quick auditioning in the flat list. One persistent player supports play/pause, seeking, Previous/Next, Loop, Close, and expandable video while browsing or using Chat.
- New writes never start playback. Replacing a playing file surfaces New render available and an explicit Reload action rather than silently restarting or mixing revisions.

## Capabilities

### New Capabilities

- `recent-files`: disk-write ordering, live Recent results, lightweight recency annotations, filename/path filtering, and stable interaction during updates.
- `media-delivery`: bounded, authenticated HTTP media delivery with byte ranges, revision checks, cancellation, and explicit response semantics.
- `media-playback`: browser-native audio/video decoding with one persistent audition session and media-list controls.

### Modified Capabilities

- `sidebar-shell`: All/Recent/Changed controls, a quieter count, and Files options.
- `document-tree`: replace count breakdowns with a current-view count and reuse native ignored styling without disturbing Pierre's tree ownership.
- `tree-filtering`: separate Git-ignore visibility from explicit exposure exclusions and support narrow generated-output includes.
- `document-watch-index`: index the allowed ignored-file superset, classify media for preview, and make active-media revision changes explicit.
- `personal-workspace-state`: extend the Files view and persist ignored-file visibility without commanding another open client.
- `document-routing`: support media previews on direct URLs, personal resume, and Back/Forward without autoplay.
- `touch-navigation`: distinguish audition actions from preview navigation and accommodate the persistent player above the existing tabs.
- `hub-live-stream`: explicitly exclude finite media responses from the one pushed-update connection guarantee.

## Impact

- Client work centers on `src/sidebar/`, `src/preview/`, a new `src/media/` playback owner, shell state/persistence/layout, and shared file-kind helpers. Existing `mtimeMs` and document revisions supply recency and invalidation.
- Server work touches ignore configuration/policy, observation and indexing, shared route declarations, file delivery, the Hub proxy, and a narrowly scoped node:http response-writing boundary at child and Hub listeners. This boundary preserves exact streamed media lengths and cancellation on Bun 1.4.4 while retaining existing Bun routing for other traffic, HTMLBundle assets, live streams, and WebSockets. All browser URLs/origins, workspace base paths, Hub authentication, and loopback child isolation remain intact; no additional browser media host or port is exposed.
- Update the published personal-state/live-payload schemas, API revision declarations, and personal-state validation where those public contracts change. Media delivery remains an internal child protocol: document and test its HTTP semantics and classify GET/HEAD through explicit machine-checkable exclusions, without publishing child operations or expanding the public Hub API. No player library, transcoder, separate media host, or additional live-update transport is required.
- Verify desktop and mobile Chromium/WebKit behavior, Hub range/cancellation behavior, ignored-output discovery, multi-client isolation, and physical iOS playback acceptance.
- Ship in the stated phase order so Recent and the simpler Files header can be reviewed and used before the media work is complete. Waveform generation, transcoding, editing/alignment timelines, automatic playlists, and playback across full workspace/page navigation are outside this change.
