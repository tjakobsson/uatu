# Recent and media PR evidence

PR-time capture using `tests/e2e/evidence.ts`, Bun 1.4.4, and Playwright Chromium and WebKit. Media-workflow screenshots use a 390 × 844 touch-enabled viewport. All content is synthetic: fixture Git history, generated WAV/MP4 files, and Fixture Agent chat in isolated temporary workspaces. These are automated browser checks, not physical-device tests.

## Screenshots

### Visible decoded video

| Browser | Expanded H264 video with playback controls | Decode report |
| --- | --- | --- |
| Chromium | [Video](chromium-native-h264.png), 43,156 bytes | [Checks](chromium-video-codec.txt), 189 bytes |
| WebKit | [Video](webkit-native-h264.png), 68,549 bytes | [Checks](webkit-video-codec.txt), 189 bytes |

Both 1280 × 720 screenshots visibly show a browser-decoded frame from the synthetic four-second, 32 × 32 solid-blue H264 Baseline fixture. The square frame is displayed at about 259 × 259 pixels inside the expanded player, with black pillarboxing, Pause, Compact, Fullscreen, and seek controls. This fixture contains solid-color frames, not production animation content. Pink masks cover only temporary workspace-path labels; the decoded video and controls are unobscured. Both final images were visually reviewed.

The targeted H264 tests **passed 2/2 in 2.7 seconds**, using Bun 1.4.4, one worker, and zero retries. Checks verify actual `videoWidth=32`, native playback, seeking to at least 1.4 seconds, the same single video element after expansion, `readyState >= 2`, completed seeking, and visible controls. Canvas sampling of the decoded video returned RGBA `[47,125,175,255]` in Chromium and `[64,136,184,255]` in WebKit. Capture happens before fullscreen; the existing fullscreen and Close assertions still run afterward.

### Recent and audio workflow

| Scenario | Chromium | WebKit |
| --- | --- | --- |
| Recent, `render-` query, audio-only results from Git-ignored `build/renders`, and active playback | [Files](chromium-generated-media-files.png), 51,641 bytes | [Files](webkit-generated-media-files.png), 65,155 bytes |
| Playback persists while sending a Chat message; Loop is enabled | [Chat](chromium-generated-media-chat.png), 36,796 bytes | [Chat](webkit-generated-media-chat.png), 46,900 bytes |
| After explicit Reload and resuming playback: new 10-second render, Loop reset, latest write first | [Reloaded](chromium-generated-media-reloaded.png), 48,653 bytes | [Reloaded](webkit-generated-media-reloaded.png), 62,178 bytes |

The six audio-workflow PNGs total 311,323 bytes. Supporting reports: [Chromium](chromium-media-workflow.json), 304 bytes; [WebKit](webkit-media-workflow.json), 303 bytes. The two additional video PNGs total 111,705 bytes.

## Verification

**16 passed in 25.8 seconds**, one worker, zero retries. The run covered both engines in `recent-files.e2e.ts` and `media-workflow.e2e.ts`.

Assertions cover Recent query/counts, live reorder and pointer stability, windowed scrolling/focus, narrow layouts, ignored-output classification, audio/video filtering, paused filename navigation, persistent playback across Files/Preview/Chat, and explicit revision Reload. Reload paused at zero before playback was resumed for the final screenshot. Both engines reported MP4 support, three ignored outputs, and one live stream. Listing generated media fetched no media contents. The harness logged upstream-unreachable messages; all targeted tests passed.

## Capture command

### Video only

Run from the repository root with Bun 1.4.4 on `PATH`, including for the fixture server's child process. This reproduces only the two H264 tests without recapturing audio evidence:

```sh
evidence_root="$(mktemp -d "${TMPDIR:-/tmp}/recent-media-video-evidence.XXXXXX")"
env -u CI -u UATU_E2E_BINARY -u UATU_E2E_LEG \
  UATU_E2E_BASE_PORT=28840 \
  UATU_E2E_HUB_BASE_PORT=28940 \
  UATU_E2E_WORKSPACE_ROOT="$evidence_root/workspaces" \
  UATU_E2E_SCREENSHOTS_DIR=openspec/changes/add-recent-media-browsing/screenshots \
  bun run test:e2e tests/e2e/media-playback.e2e.ts \
  --grep='H264 video decodes' --project=e2e --workers=1 --retries=0 --reporter=list \
  --output="$evidence_root/test-results"
```

The fixture server used port 28840. Playwright outputs remain in the isolated temporary directory. The harness logged an upstream-unreachable message; both tests passed.

### Recent and audio workflow

Run from the repository root with Bun 1.4.4. This reproduces the capture with a
fresh temporary workspace and the same ports and test options:

```sh
evidence_root="$(mktemp -d "${TMPDIR:-/tmp}/recent-media-pr-evidence.XXXXXX")"
env -u CI -u UATU_E2E_BINARY -u UATU_E2E_LEG \
  UATU_E2E_BASE_PORT=28640 \
  UATU_E2E_HUB_BASE_PORT=28740 \
  UATU_E2E_WORKSPACE_ROOT="$evidence_root/workspaces" \
  UATU_E2E_SCREENSHOTS_DIR=openspec/changes/add-recent-media-browsing/screenshots \
  bunx bun@1.4.4 run test:e2e tests/e2e/recent-files.e2e.ts tests/e2e/media-workflow.e2e.ts \
  --project=e2e --workers=1 --retries=0 --reporter=list \
  --output="$evidence_root/test-results"
```

The fixture server used port 28640. Playwright output and `.last-run.json` were
kept in the temporary test-results directory; the run recorded `passed` with no
failed tests. For another capture, allocate a fresh temporary root as above.
