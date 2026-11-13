# OpenCode chat screenshots

The [PR #519 description](https://github.com/tjakobsson/uatu/pull/519) owns the feature screenshot gallery; PNGs are not tracked here. This index describes 19 current captures prepared from committed implementation `06159135af7b3499e620a999724fcbe6f1478b7b`: the existing 17 purposes plus two local-discard frames. Independent image/caption/privacy review and user approval precede publication.

Physical-iPhone retesting of the picker correction remains user-owned and pending. Chromium and WebKit browser regressions passed; the gallery itself is Chromium capture evidence, not physical-device or WebKit screenshot evidence.

Actual application captures in Chromium, light/dark themes: desktop gallery **1440 × 1000 CSS pixels**, desktop discard **1360 × 960**, mobile **390 × 844**. The restored-picker frame uses **393 × 704 CSS pixels at 3× device scale** (1179 × 2112 PNG). These are synthetic documentation fixtures, not personal conversations, provider benchmarks, native iPhone captures or live-model acceptance. No paid generation or live Hub was used. See [current chat behavior](../../CHAT.md).

The standard workspace contains only the E2E sample README/files. Model names, context figures, jobs, questions and answers are scripted. The preferences capture uses an isolated test Hub/account with an empty credential store. No authentication URLs, credentials, private filesystem paths, real costs, or original user photographs are included.

| Capture | What to look for |
| --- | --- |
| Overview, light | Idle composer, selected fixture model, draft and 32% context occupancy. |
| Configuration, light | Model, mode and Medium reasoning selection in the real picker. |
| Workers, dark | Aligned agent, task, model + last-used effort, cumulative tokens and session USD cost; independent 28px Stop and Inspect targets. Scripted medium/high, zero and sub-cent values are not real charges. Narrow panes wrap metadata minimally. |
| Expanded queue and workers, light | Expanded worker overview and a queue reporting twenty follow-ups in separate scrollports; only viewport rows are shown. |
| Hold at 1.0 seconds, dark | After 500ms silent arming, 0.5s into the countdown: the full envelope is already 104px above unchanged Send. |
| Hold at 2.1 seconds, dark | Identical outer bounds, increased green fill; 0.4 seconds remain before the 2500ms queue deadline. Raw frames, not a fabricated animation. |
| Worker inspection, dark | Child transcript, Back and scoped Stop worker, while the parent worker overview remains. |
| Question with running work, light | An unanswered choice remains actionable while an independent worker runs; the composer draft is retained. |
| Side answer ready, dark | `/btw` completion stays at the transcript edge, outside the composer. |
| Formatted side reader, dark | Larger nonmodal reading window, real sanitized Markdown and workspace reference; composer/workers remain interactive, Minimise retains the answer. |
| Personal preferences, light | Account-level automatic-background preference and its explanation, in an isolated synthetic Hub. This saved-state frame does not demonstrate unsaved/conflict handling. |
| Unknown receipt, dark | Lost-acknowledgement fixture with an expanded pending steer. Receipt feedback beneath the composer is clipped; this frame does not fully display the unconfirmed-delivery or Do not repeat guidance. |
| Replacement warning, light | After Undo, the worker header reports 19 working tasks above one paused steer and a queue reporting 19 follow-ups with the replacement warning; only viewport rows are shown. |
| Mobile side reader, light | Existing mobile modal with the same accessible Minimise action. |
| Mobile minimised answer, light | Unblocked conversation and composer; the existing notice reopens the retained answer without inference. |
| Mobile picker after viewport restoration | Picker restored from 360 to 704 CSS pixels while open, with complete model rows; not a physical-device keyboard capture. |
| Next-turn settings before steering | Next turn Plan selection and visible pre-send explanation; the fixture verifies that the steer retains Build while queued work adopts Plan. |
| Discard local record, desktop | Cancel-focused confirmation: removal does not cancel or resend the message; the original may still arrive. Other messages remain queued until Send now, a fresh accepted message or a later normal idle transition. This is confirmation-state evidence, not a completed-discard image. |
| Durable discard guidance, touch | Synthetic fixture after local discard and release of the application's delayed SSE removal event: complete persistent uncertainty guidance, the unrelated draft, and one remaining held queued input. |

Overview/configuration/question use the scripted chat-service fixture so all model metadata can be selected without inference. The other chat captures run the production adapter/provider against the local scripted OpenCode 2.x HTTP server. Side-reader responses use deterministic Markdown (the desktop request completes against the native fixture first; mobile is browser-stubbed). Desktop gallery widens the actual chat split to demonstrate its container-based single-line density. Screenshots show rendered application states, not mock HTML.

Worker effort is OpenCode execution-reported metadata, not a downstream-provider
behavior guarantee or the parent's configured reasoning choice. A dash has an
accessible “not reported” label. Cost uses the child's authoritative native
`SessionInfo.cost` / `session.usage.updated.cost` cumulative USD snapshots, including
compaction and reverted spend, not latest-call prices or message sums. Parent and
descendant totals are not added. Reported zero remains zero; missing aggregate data
remains unknown. Current Claude and OpenCode 1.x integrations leave effort/session
cost unreported rather than guessing from configuration, message prices or models.

## Capture local artifacts

When new captures are explicitly requested, use the repository's existing dependencies and Playwright browsers:

```sh
UATU_CAPTURE_CHAT_SCREENSHOTS=1 bunx playwright test \
  tests/e2e/chat-screenshots.e2e.ts tests/e2e/chat-screenshots-hub.e2e.ts \
  --project=e2e --workers=1
```

Captures use Playwright's per-test `test-results/` output paths and PNG report attachments through `tests/e2e/evidence.ts`. These outputs are ignored by Git; the tests do not write to this documentation directory. Leave `UATU_E2E_SCREENSHOTS_DIR` unset for local-only output (the shared evidence helper can otherwise copy captures to an explicitly chosen evidence folder).

To select only the two hold frames from the desktop gallery writer:

```sh
UATU_CAPTURE_CHAT_SCREENSHOTS=1 UATU_CAPTURE_HOLD_ONLY=1 bunx playwright test \
  tests/e2e/chat-screenshots.e2e.ts --project=e2e --workers=1 --grep 'desktop documentation gallery'
```

Normal tests skip these gallery writers. Review image privacy and captions before publication. Capture helpers assert key rendered states; the gallery itself is not independent validation. Hold/queue regressions live in `tests/e2e/chat-hold-queue-regressions.e2e.ts`; the reference-workdock suite covers normal/short/mobile/enlarged-text layouts and independent scrolling. Nonzero viewport/fixed-origin checks are synthetic. No agent native-device result is claimed.

The two local-discard frames come from the real-adapter regression against the
scripted OpenCode HTTP server; the selected gallery uses Chromium desktop and touch.
The refresh also runs the desktop held-unknown-admission case, but its collapsed
queue frame is not selected for the gallery:

```sh
bun run test:e2e tests/e2e/chat-discard-unconfirmed.e2e.ts \
  --project=e2e --workers=1 \
  --grep 'local discard (desktop|touch) chromium.*confirms local-only removal|local discard desktop chromium.*held unknown admission'
```

All eight committed-source capture cases passed at `0615913`, using one worker,
existing budgets and zero retries; 19 images are selected. This focused capture
run is not a full test suite. The earlier `8d621b1` capture batch had one desktop
discard timeout after its confirmation image; the current passes do not establish
that historical failure's cause. Scripted captures do not close outstanding
native-service, physical-device or screen-reader speech checks.

To select the nine-frame worker-focused subset from the desktop gallery writer:

```sh
UATU_CAPTURE_CHAT_SCREENSHOTS=1 UATU_CAPTURE_WORKERS_ONLY=1 bunx playwright test \
  tests/e2e/chat-screenshots.e2e.ts --project=e2e --workers=1 --grep 'desktop documentation gallery'
```

The selection flags filter the named gallery frames; the supplementary `desktop-side-reader-light` report attachment is still produced. The mobile test also attaches `mobile-side-reader-dark` when included in the run. Neither supplementary attachment is selected for the PR gallery.

The two additional picker/configuration frames come from normal regression evidence:

```sh
bunx playwright test tests/e2e/chat-mobile-picker-clipping.e2e.ts \
  tests/e2e/chat-configuration-truth.e2e.ts --project=e2e
```
