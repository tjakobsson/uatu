## 1. Dependencies and pins

- [x] 1.1 Pin `@anthropic-ai/claude-agent-sdk` to the exact lockfile version and add `badge-maker` as a dev dependency; verify `bun install` is clean and `bun run check:licenses` passes

## 2. Normalizer hardening (observability the probe relies on)

- [x] 2.1 Make the Claude block loops report skipped block types on the normalized event and count them in the adapter as `chat.block.unrecognized.<type>` under the existing distinct-type cap; verify with a normalization test feeding `redacted_thinking` and `server_tool_use` blocks that the known blocks still render and the skips are reported
- [x] 2.2 Wrap `normalizeClaudeMessage` so a throwing case resolves to `outcome: "unparseable"` instead of propagating; verify with a test that a recognized subtype with a broken payload yields `unparseable` and a following message still normalizes
- [x] 2.3 Give OpenCode's `normalizePart` fallthrough the same skipped-part report; verify with a v2 normalization test feeding a `snapshot` part
- [x] 2.4 Make an unmatched Claude `system` subtype resolve to `unrecognized` unless `INTENTIONALLY_IGNORED` names it, counted as `chat.event.unrecognized.system.<subtype>` under the same cap; verify with a normalization test that `model_refusal_no_fallback` is unrecognized and `hook_started` is ignored, and an adapter test that the counter key names the subtype
- [x] 2.5 Give the shared OpenCode core a deliberate part ignore set (`step-start`, `step-finish`, `snapshot`) that is neither rendered nor counted, reported as ignored with reasons; verify with a 1.x normalization test that those parts report no skip and that `patch` still does
- [x] 2.6 Take off the ignore lists the types no reason can be verified for — Claude `local_command_output`, `informational`, `conversation_reset`, `permission_denied`, `notification`, `auth_status`, `files_persisted`, `elicitation_complete`; 2.x `session.inbox.cancelled`, `session.forked`, `session.moved`, `session.skill.activated` — so they count and report as unhandled; verify the regenerated matrices list them as unhandled

## 3. Vocabulary extraction

- [x] 3.1 Implement per-agent extractors in `scripts/agent-coverage.ts` for Claude (message types/subtypes from `sdk.d.ts`, block types, tool `*Input` names from `sdk-tools.d.ts`, CLI version from `manifest.json`) and OpenCode (v1 events/parts from `@opencode-ai/sdk`, v2 events/parts from `@opencode/schema`); verify with a test that each axis meets its floor against the installed packages
- [x] 3.2 Make an axis below its floor throw naming the file and pattern; verify with a test pointing an extractor at a stub file

## 4. Classification and annotations

- [x] 4.1 Add `src/chat/claude/sdk-coverage.ts` and `src/chat/opencode/sdk-coverage.ts` exporting reasons, behavior-missing entries (ScheduleWakeup, CronCreate, and the `/loop` path, whose reasons name the scheduled-wakeups change), and the Claude input-name → wire-name map; verify with a test that every key resolves to an extracted vocabulary entry and that an unknown key is rejected
- [x] 4.2 Implement the probes: message types through each normalizer, blocks/parts through a synthetic message, tools through `describeToolDetail`; verify with tests that `Bash` is dedicated, `ScheduleWakeup` is behavior-missing, `Monitor` is generic, `hook_started` is ignored, and `active_goal` is unhandled for the installed Claude SDK
- [x] 4.3 State OpenCode's tool axis as not enumerated by its SDK, listing only the names the renderer treats as dedicated; verify the matrix section says so
- [x] 4.4 Make a reason required for every ignored entry, with family keys (`<prefix>*`, most specific wins) in the annotations; verify with tests that a missing reason fails naming the entry, a family covers its members, an exact key overrides a family, and a family matching nothing fails

## 5. Outputs

- [x] 5.1 Render `docs/agents/<agent>.md` with a version header, one table per axis (name, state, reason), and a "since <previous version>" section computed from the previously committed matrix; verify by running the generator twice and diffing for byte identity
- [x] 5.2 Render `docs/agents/<agent>.svg` with `badge-maker` showing agent, version, and gap count, colored green at zero gaps; verify the SVG contains no timestamp and the freshness run reproduces it
- [x] 5.3 Rewrite the README block between `agent-coverage` markers — placed after the Features list, with a sentence saying what the badges measure — with repository-relative badge images linked to the matrices; verify `grep -c 'img.shields.io\|https://' ` over the block returns zero and the links resolve in the checkout
- [x] 5.4 Add the `coverage:agents` script to `package.json` and commit the first generated outputs; verify `bun run coverage:agents` exits zero and produces the four files plus the README block

## 6. Freshness and documentation

- [x] 6.1 Add the freshness test that regenerates in memory and compares against the committed matrices, badges, and README block, failing with the stale path; verify it passes on the committed outputs and fails after editing one character of a matrix
- [x] 6.2 Document regeneration in CONTRIBUTING.md's validation section and the state vocabulary at the top of each matrix; verify the CONTRIBUTING text names the script and the trigger (an SDK bump)
- [x] 6.3 Note the coverage report and its annotations modules in CLAUDE.md's folder map and ARCHITECTURE.md's chat section; verify the entries point at the real paths
