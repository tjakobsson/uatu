# Git worktree creation in Uatu: compatibility research

Research date: 2026-09-16. Status: alternatives and recommendation, **not an
approved implementation plan**. No product code changed or live provider
compatibility tests performed. Findings are based on official documentation,
version-pinned OpenCode source, and the current Uatu codebase.

## Recommendation

**Uatu should create ordinary Git worktrees and register each as an independent
Hub workspace. Claude Code and OpenCode should run normally in that directory.**

Keep creation ownership separate from discovery and use:

- Uatu-created worktrees: Uatu records creation provenance and controls its own
  lifecycle actions.
- Agent-created worktrees: discover/open without claiming ownership or cleanup.
- Unknown/manual worktrees: discover/open without guessing ownership from path
  or branch names.

Do not override Claude's worktree hooks or use OpenCode's experimental lifecycle
API for this baseline. Both providers already support working in an existing
Git checkout. This preserves their native worktree features rather than trying
to reproduce them. [C1, C3, O1, O3]

This is a coexistence design, not a security boundary: agents, terminals and
external tools still run with filesystem access and can mutate shared Git state.
Uatu cannot guarantee that another tool will never remove a Uatu worktree.

## Alternatives

| Alternative | Benefits | Costs / compatibility risks | Assessment |
|---|---|---|---|
| **A. Uatu-owned Git creation; one Hub workspace per worktree** | Provider-neutral; explicit branch/base/path; reuses Uatu's cwd and session model | Uatu must handle Git errors, provenance, registration, and safe folder actions; agent-specific setup is not automatic | **Recommended baseline** |
| **B. Delegate creation to the selected agent** | Native naming, storage and setup behavior | Claude and OpenCode have different contracts; OpenCode API is experimental; Claude has no documented first-class main-query SDK worktree option; mixed-provider ownership is awkward | Optional later integration, not the default |
| **C. Uatu-owned creation plus discovery/opening of agent/manual worktrees** | A unified navigator without taking over native behavior | Discovery does not establish ownership; ephemeral agent worktrees can disappear; Uatu cannot transparently import every agent conversation | Good extension of A |
| **D. Uatu becomes the agents' worktree backend** | Centralized policy and possible automatic registration | Claude hooks replace creation, including subagent isolation; no equivalent stable common OpenCode contract; must preserve hooks, cleanup and failure semantics | Too invasive for the initial feature |
| **E. Multiple worktrees inside one running Uatu workspace** | Potentially smoother switcher / task-oriented UI | Watch roots, terminal cwd, agent runtimes and conversation scope are currently workspace-bound; switching requires broader lifecycle changes | Separate future architecture project |

A full clone is another isolation option, but it is not a linked worktree: it
duplicates repository state and does not provide the desired shared repository
semantics. It is unnecessary for the stated feature. [G1]

## What the providers actually support

### Claude Code

Official documentation explicitly supports manual creation followed by entering
the directory and running plain `claude`. Its worktree behavior applies to
worktrees created by `git worktree add`, not only by Claude. The SDK supplies
`cwd` for selecting an existing checkout. [C1, C3]

Native Claude functionality to leave intact:

- `claude --worktree <name>` defaults to `.claude/worktrees/<name>` and branch
  `worktree-<name>`; an existing named worktree can be reopened.
- Subagents can request `isolation: worktree`. These remain Claude-managed
  resources, even when the main session starts in a Uatu-created checkout.
- The current default base is the remote default branch (`worktree.baseRef:
  "fresh"`), not necessarily the parent session's `HEAD`; `"head"` changes this.
  Uatu must not promise that isolated subagents inherit a selected feature base.
- `WorktreeCreate` **replaces**, rather than observes, default creation. It also
  affects isolated subagents. Replacing it requires a corresponding cleanup
  implementation and preserving user/project configuration intentionally.
- `.worktreeinclude` copies selected ignored files during Claude's default
  creation, not when Uatu creates a worktree or replaces creation with a hook.
- Non-interactive `--worktree` sessions leave worktrees behind rather than
  performing interactive exit cleanup. [C1, C2, C4]

Current Claude documentation describes ownership markers used by its cleanup
sweep to retain manually created worktrees. It dates that safeguard to v2.1.246;
older versions must not be assumed to behave identically. The marker format is
not a public integration API: Uatu should not write or reverse-engineer it. [C1]

The SDK has explicit session IDs/resume, and conversation forking does not fork
the filesystem. Use an explicit session ID with the correct workspace cwd, not
"continue the most recent session" across worktrees. Claude can itself bind a
session to a worktree; resume behavior is version-sensitive. Uatu's exact-cwd
history filter means discovery of a worktree is **not** a guarantee of seamless
native transcript import or mid-conversation movement. [C1, C3, C5; U3]

Do not rely on the interactive CLI trust dialog to protect SDK execution:
non-interactive trust behavior differs. Opening a checkout can load project
configuration, hooks and instructions, depending on SDK settings. Worktrees are
not isolation from credentials, permissions or executable project setup. [C6, C7]

### OpenCode

The SDK exposes `client.worktree.create/list/remove/reset`, but routes live under
`/experimental/worktree`. These are implemented APIs, **not a stable public
contract**. The official SDK/server API tables do not describe them. A separate
`experimental.workspace` API concerns adapter-backed workspaces and control-plane
session movement; it is not needed to open ordinary local Git worktrees. [O1, O2, O5]

At the inspected version:

- Creation uses OpenCode's data directory, a project-specific worktree folder,
  and an `opencode/<name>` branch.
- Creation returns before asynchronous checkout/bootstrap completes.
  `worktree.ready` is emitted before startup scripts finish; it is not a full
  environment-readiness signal. Failed setup can leave resources behind.
- Listing uses Git's worktree list and includes externally created linked
  worktrees. **Listed does not mean OpenCode-owned.**
- Removal can invoke `git worktree remove --force`, recursively remove the
  directory and `git branch -D` the associated branch. It does not restrict this
  behavior to OpenCode-created worktrees.
- Reset can hard-reset a linked worktree to the default branch and run
  `git clean -ffdx`, including ignored files, plus submodule cleanup. [O1]

These removal/reset semantics are the strongest reason not to use OpenCode as
Uatu's general lifecycle backend.

OpenCode resolves runtime instances by directory and groups linked checkouts
under repository-level project identity. Uatu should consistently pass the
selected worktree as `directory`. Uatu already applies its own exact canonical
directory filter to conversation membership, beyond any provider-side filter.
[O3; U3]

Tracked project config/plugins are available in a new checkout. Opening it can
load plugins and trigger dependency installation. OpenCode's worktree startup
commands are distinct from `session.init`, which creates/analyzes `AGENTS.md`;
Uatu should not call that merely to initialize a worktree. External Git creation
does not automatically run OpenCode's worktree creation startup commands. [O1, O4, O5]

### Version scope

Uatu currently declares Claude Agent SDK `^0.3.252`, locked to `0.3.261`, and
OpenCode SDK `1.18.30`. The OpenCode executable is discovered separately; its
version need not equal the client SDK version. [U4]

OpenCode source was inspected at v1.18.30 commit
`3104c1428ec91f809e5ab86631300de41eb6952e` and dev commit
`350c726aa8b6b11eb9242040bc5eb7ae837fbf8a`. Core worktree behavior matched in
those snapshots. Claude findings describe the live documentation, which can
include behavior newer than the bundled runtime. Test against the actual
supported binaries before claiming compatibility.

## Fit with Uatu today

The Hub registers absolute folders, gives each a stable workspace ID, and starts
one child with that folder as its watch root. The first canonical root supplies
both agents' and the terminal's cwd. Therefore a separately registered worktree
fits the current runtime without changing its conversation model. [U1, U3]

Existing-folder registration already largely understands linked worktrees:
Git probing uses `rev-parse`, the directory browser accepts `.git` files, and
the scanner excludes `.git`. New-folder creation currently uses `git init`, so
the missing operation is Git-aware worktree creation plus onboarding. [U2]

Important caveats:

1. **Folder rename is not safe as-is.** The folder manager uses filesystem
   rename and rewrites registry paths, not `git worktree move/repair`. Moving a
   linked worktree, the main checkout/common Git directory, or an ancestor can
   break Git's links. Guard related moves, including dependencies on worktrees
   not registered in Uatu. A primary-repository rename is not safe merely
   because its own `.git` directory moves with it. [U5, G1]
2. **Forget is not delete.** Current unregister leaves the folder on disk and
   is suitable for external worktrees. Folder removal uses non-recursive
   `rmdir`, so populated worktrees normally fail safely; this is not a worktree
   deletion implementation. [U5]
3. **Credentials are workspace-ID scoped.** A new registration needs explicit
   credential-assignment policy; do not silently assume inheritance. Reuse the
   onboarding journal/assignment coordination. [U1, U2]
4. **Git metadata is outside the watched checkout.** File watching excludes
   `.git`; metadata-only changes may not immediately refresh Git UI. Use
   explicit refresh after Uatu operations rather than blindly watching the
   shared Git directory. [U6]
5. **Shared refs/config still exist.** Worktrees have separate files, index and
   HEAD, but share most refs and default Git config. Coordinate Uatu operations
   by canonical Git common directory as well as destination path; Git remains
   the authority when external tools race. [G1; U2]

## Smallest useful implementation to validate

Start with **Create worktree → Open as new workspace**, not automatic cleanup or
moving an existing conversation.

1. Select source repository, destination, new branch name and explicit starting
   revision. Suggest the selected checkout's HEAD, while showing the choice.
2. Canonicalize the existing destination parent; validate branch/ref and path;
   reserve destination and coordinate repository mutation. Use argument arrays,
   not shell interpolation, and reject invalid/option-like inputs.
3. Run bounded Git creation, conceptually:
   `git -C <source> worktree add -b <branch> -- <destination> <start-point>`.
   Do not use `--force` or `-B`; preserve Git's branch-in-use safeguards. [G1]
4. Verify the resulting checkout/repository, record creation provenance, and
   register through the existing onboarding transaction. If registration fails,
   retain and report the created checkout for recovery instead of destructively
   rolling it back after another process could have started using it.
5. Open a separate Hub workspace. Leave existing conversations in the source
   workspace untouched. Claude receives `cwd`; OpenCode receives `directory`.
6. Keep provider-native worktree behavior enabled and unmodified. Do not place
   Uatu creations in provider-reserved directories or impersonate their metadata.
7. Block unsafe generic folder moves; offer display-name edits and forget only.
   Defer Git-aware move/delete and automatic cleanup.

For a subsequent discovery feature, use `git worktree list --porcelain -z`,
which Git documents as a stable machine-readable format. Present discovered
worktrees as external unless Uatu has durable creation provenance. [G1]

Creation does not copy source uncommitted edits, ignored `.env` files or
dependencies. Explain this in the UI. Setup scripts, secret copying, dependency
installation and credential inheritance need separate explicit policy. Git
checkout itself may execute configured hooks/filters, so "create" is not a
guaranteed side-effect-free operation in an untrusted repository.

## Validation before shipping

- Create from main and linked checkouts; branch collision, already-checked-out
  branch, dirty source, symlink parent, unusual path characters and failed Git.
- Concurrent create, registration failure, retry and Hub restart recovery.
- Claude SDK new conversation/resume in the new checkout; source history stays
  separate; native isolated subagents and existing user hooks still work.
- OpenCode conversation/event directory scoping with the actual launched
  binary, not only the pinned SDK; native worktree creation remains functional.
- External Claude/OpenCode worktrees can be opened without Uatu claiming them;
  external deletion or movement produces a missing-workspace state, not silent
  recreation at a reused path or fallback to another checkout.
- Terminal, preview, search and Git views agree on the selected checkout.
- Unsafe linked/main/ancestor folder moves are rejected server-side; unregister
  preserves Git metadata and files.
- Document/test Git-version and submodule limitations. Git's manual explicitly
  warns that multiple-checkout submodule support remains incomplete. [G1]

These checks have **not** been run as part of this research.

## Decisions still open

- Location: sibling directories or a configurable Uatu-managed root? Prefer
  outside the source checkout to avoid nested scans and provider path overlap.
- Initial UI: one independent workspace per worktree is simplest; repository
  grouping can improve navigation later without changing runtime identity.
- Scope: new branches only first, or existing branches/detached checkouts too?
- Setup: no automatic setup initially, or explicit user-approved commands?
- Credentials: explicit copy confirmation or fresh selection?
- Discovery: on-demand listing first, or automatic observation of agent worktrees?
- Is transparent following of an agent's mid-conversation worktree transition
  required? That is a larger feature than creation and needs separate design.

## Sources

External primary sources, consulted 2026-09-16:

- **G1:** [Git worktree manual](https://git-scm.com/docs/git-worktree)
- **C1:** [Claude Code worktrees](https://code.claude.com/docs/en/worktrees)
- **C2:** [Claude Code hooks](https://code.claude.com/docs/en/hooks#worktreecreate)
- **C3:** [Claude Agent SDK TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- **C4:** [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- **C5:** [Claude Agent SDK sessions](https://platform.claude.com/docs/en/agent-sdk/sessions)
- **C6:** [Claude Code security](https://code.claude.com/docs/en/security)
- **C7:** [SDK configuration loading](https://platform.claude.com/docs/en/agent-sdk/claude-code-features)
- **O1:** [OpenCode worktree implementation, v1.18.30](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/worktree/index.ts)
- **O2:** [OpenCode generated SDK, v1.18.30](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/sdk/js/src/v2/gen/sdk.gen.ts)
- **O3:** [OpenCode project resolution](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/project/project.ts) and [directory instance store](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/project/instance-store.ts)
- **O4:** [OpenCode configuration](https://opencode.ai/docs/config/) and [plugins](https://opencode.ai/docs/plugins/)
- **O5:** [OpenCode SDK docs](https://opencode.ai/docs/sdk/) and [server docs](https://opencode.ai/docs/server/)

Local evidence (line numbers refer to the checkout examined during research):

- **U1:** `src/hub/registry.ts:15-25,62-70,282-290` (workspace identity);
  `src/hub/backend.ts:91-128` (child root/environment);
  `src/hub/sessions.ts:281-303` (credential-aware spawn).
- **U2:** `src/hub/git.ts:124-135` (Git probe);
  `src/hub/onboarding.ts:678-769` (existing/create flows);
  `src/hub/path-reservations.ts:7-45` (overlap fencing);
  `src/hub/server.ts:536-541` (`.git` file recognition).
- **U3:** `src/cli.ts:191-237` (agent/terminal roots);
  `src/chat/workspace.ts:18-61` (canonical cwd/membership);
  `src/chat/adapter.ts:689-695` (session membership enforcement);
  `src/chat/claude/provider.ts:397-409,2843-2849` (cwd/state);
  `src/chat/claude/transcript.ts:7-43` (transcript namespace);
  `src/chat/opencode/sdk-v2-provider.ts:35-49,193-203,493`
  (client/request/event directory binding).
- **U4:** `package.json`, `bun.lock`;
  `src/chat/opencode/opencode-service.ts:164-191` (external server startup).
- **U5:** `src/hub/folder-manager.ts:549-629,857-902,985-1095`
  (rename/remove); `src/hub/server.ts:1754-1831` (forget).
- **U6:** `src/server/watch-session.ts:132-180` (Git exclusions);
  `src/document/git-data.ts:58-109` (repository grouping).
