# Recent and media PR evidence

PR-time capture using `tests/e2e/evidence.ts`, Bun 1.4.4, and Playwright Chromium and WebKit. Media-workflow screenshots use a 390 × 844 touch-enabled viewport. All content is synthetic: fixture Git history, generated WAV/MP4 files, and Fixture Agent chat in isolated temporary workspaces. These are automated browser checks, not physical-device tests.

## Screenshots

| Scenario | Chromium | WebKit |
| --- | --- | --- |
| Recent, `render-` query, audio-only results from Git-ignored `build/renders`, and active playback | [Files](chromium-generated-media-files.png), 51,641 bytes | [Files](webkit-generated-media-files.png), 65,155 bytes |
| Playback persists while sending a Chat message; Loop is enabled | [Chat](chromium-generated-media-chat.png), 36,796 bytes | [Chat](webkit-generated-media-chat.png), 46,900 bytes |
| After explicit Reload and resuming playback: new 10-second render, Loop reset, latest write first | [Reloaded](chromium-generated-media-reloaded.png), 48,653 bytes | [Reloaded](webkit-generated-media-reloaded.png), 62,178 bytes |

Six PNGs total 311,323 bytes. Supporting reports: [Chromium](chromium-media-workflow.json), 304 bytes; [WebKit](webkit-media-workflow.json), 303 bytes.

## Verification

**16 passed in 25.8 seconds**, one worker, zero retries. The run covered both engines in `recent-files.e2e.ts` and `media-workflow.e2e.ts`.

Assertions cover Recent query/counts, live reorder and pointer stability, windowed scrolling/focus, narrow layouts, ignored-output classification, audio/video filtering, paused filename navigation, persistent playback across Files/Preview/Chat, and explicit revision Reload. Reload paused at zero before playback was resumed for the final screenshot. Both engines reported MP4 support, three ignored outputs, and one live stream. Listing generated media fetched no media contents. The harness logged upstream-unreachable messages; all targeted tests passed.

## Capture command

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
