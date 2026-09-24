## Why

OpenCode 2.0 shipped (2.0.13 at the time of writing) with a rebuilt server API, and anomalyco keeps publishing the 1.18.x line beside it. A workspace whose `opencode` is a 2.x binary cannot start Chat today: uatu's readiness probe asks `GET /global/health` for `{ healthy: true }`, 2.x no longer has that route, and its bundled web UI answers every unknown path with `200 text/html`. The probe reads that as "answered but never became healthy" and burns the whole health budget. Every other call uatu makes — `@opencode-ai/sdk`'s `/v2` client against `/session`, `/event`, `/permission`, `/question` — targets routes that 2.x moved under `/api/…` with new shapes and names. Users are already on 2.x (Homebrew `anomalyco/tap/opencode-v2`, and the 2.x curl installer replaces a 1.x binary in place), and upstream calls 1.x still supported, so uatu has to work with whichever generation a workspace has installed.

## What Changes

- **Startup recognizes either generation.** The spawned server is probed for both readiness contracts — 1.x `GET /global/health` → `{ healthy, version }` and 2.x `GET /api/info` → `{ version, pid, urls }` — and the first recognized JSON body decides. The HTML fallback 2.x serves on `/global/health` is never accepted as healthy. The reported version is the plain semver either way (`2.0.13`, not `opencode v2.0.13`), so the existing status and diagnostics wire shapes are unchanged and the generation is legible from the version.
- **The generation is fixed per spawned server and drives the provider.** Once the probe decides, that server is served by the matching provider stack for its lifetime; a retry that finds a replaced binary re-decides. The OpenCode agent keeps one id (`opencode`) and one conversation namespace (`opencode:<id>`) regardless of generation.
- **A second OpenCode provider stack, against `@opencode/client` 2.x.** It implements the same `ChatProvider` seam as the 1.x stack: sessions, prompt/command, interrupt (`cancel`), compaction (`compact`), staged/committed/cleared revert, permission requests (`permission.request.reply`), structured questions (2.x `form`), model/agent/command catalogs, and the `/api/event` stream with 2.x's typed event vocabulary (`SessionTextDelta`, `SessionToolCalled`, `PermissionAsked`, `FormCreated`, …) normalized into the same conversation events the client already renders. Every call is scoped to the workspace directory through 2.x's `location.directory`.
- **Diagnostics name the generation and both probes.** A failed startup says which readiness paths were probed and what each last answered, so a 2.x server behind a 1.x-only build (or the reverse) is diagnosable from the report.
- **Both generations are exercised for real.** The gated real-OpenCode integration test runs the same assertions against a 1.x and a 2.x binary; each is selected by an environment variable so neither has to be on `PATH`, and a developer can keep both installed side by side (2.x isolated by `XDG_*`).
- **The 1.x stack is renamed for what it is.** `chat/opencode/sdk-v2-provider.ts` — "v2" there means the 1.x SDK's `/v2` subpath — moves under `chat/opencode/v1/`, and the new stack lives under `chat/opencode/v2/`; `CLAUDE.md`'s folder map and `ARCHITECTURE.md` follow.

Non-goals: migrating 1.x conversations into 2.x (OpenCode's own `migration/v1` concern); running both generations inside one workspace; installing or upgrading OpenCode; 2.x's new surfaces (worktrees, inbox, skills, ptys, `opencode service`) beyond what the seam needs; changing how a session is spawned — uatu keeps a private loopback `opencode serve` per workspace, which 2.x still supports.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `opencode-chat`: "Chat uses the workspace's OpenCode installation and identity" — readiness is decided by either generation's contract, the generation is fixed per spawned server, and an HTML answer on the 1.x path is not health. "A failed Chat startup reports actionable diagnostics" — evidence names each readiness resource's last outcome. Added: "Chat serves whichever OpenCode generation the workspace has installed" — the same surface, identity, and operations on 1.x and 2.x; 2.x's event vocabulary normalized to the same conversation events; 2.x forms presented as structured questions; pending requests recovered from 2.x's own pending sets; every 2.x call scoped to the workspace directory.

`chat-agents` is unchanged: capability differences between generations already ride the agent's per-startup declaration and "an undeclared capability is not an error".

## Impact

- `src/chat/opencode/`: `opencode-service.ts` (probe both contracts, decide the generation, pass `OPENCODE_PASSWORD` alongside `OPENCODE_SERVER_PASSWORD`); `v1/` (moved `sdk-v2-provider`, `normalization`); new `v2/` (client provider + normalization against `@opencode/client`); `real-opencode.integration.test.ts` parameterized by generation.
- `src/chat/service.ts`: `openCodeAgentRuntime` picks the provider factory from the runtime's decided generation.
- `package.json`: add `@opencode/client` 2.x beside `@opencode-ai/sdk` 1.18.x (different package names; both stay). License audit re-run.
- No workspace or hub API revision: status, diagnostics, and the chat routes keep their shapes; the version string carries the generation.
- Docs: `CLAUDE.md` folder map, `ARCHITECTURE.md` chat section; a short developer note on running 1.x and 2.x side by side for the integration test.
