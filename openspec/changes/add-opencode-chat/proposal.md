## Why

UatuCode can run coding agents inside its terminal, but it has no structured conversation surface for following an agent's reasoning, tool activity, questions, permissions, and results across desktop and touch clients. An OpenCode-first web chat makes that workflow usable from browsers and the existing macOS WebView now, while giving a future iOS shell the same capability without a second chat implementation.

## What Changes

- Add workspace-scoped OpenCode conversations that use the user's existing OpenCode installation and authentication.
- Start and supervise one loopback-only OpenCode server for each running Uatu workspace that uses chat, with the workspace directory fixed by the server rather than accepted from browser input.
- Expose authenticated workspace operations for conversation inventory, history, creation, prompting, cancellation, permission responses, and structured question responses, plus a reconnectable live event stream.
- Add a web Chat surface with conversation selection, streamed Markdown responses, reasoning and tool activity, permission and question cards, cancellation, and file links into the existing preview.
- Define stable scrolling behavior for streaming, history pagination, expanding activity, reconnection, and software-keyboard viewport changes.
- Add Chat as a fourth touch-navigation tab so the same web surface works in browsers, the installed PWA, the macOS app, and a future iOS WebView shell.
- Keep OpenCode authoritative for provider conversation history while Uatu owns its normalized public API and client presentation state.
- Defer ACP and additional providers behind a future provider adapter; this change is explicitly OpenCode-only.

## Capabilities

### New Capabilities
- `opencode-chat`: Workspace-scoped OpenCode lifecycle, normalized conversation API and event stream, and the responsive web chat experience.

### Modified Capabilities
- `touch-navigation`: Expand the touch tab bar and active-tab behavior from three surfaces to four by adding Chat.

## Impact

- Affected product areas include the workspace server route table, workspace process supervision, public workspace API and streaming contracts, the SPA shell and touch navigation, a new chat feature domain, and hub proxy integration tests.
- The compiled distribution gains an OpenCode SDK dependency, while OpenCode itself remains an external executable discovered at runtime and retains ownership of provider credentials.
- Chat increases the authority exposed through authenticated workspace routes because it can instruct an agent to read, execute, and modify files as the daemon's OS user; existing hub authentication, origin checks, base-path routing, and loopback-only child services remain mandatory.
- The public workspace API revision changes if required by compatibility validation, and generated API documentation and changelog entries must remain synchronized with the new operations and stream schemas.
- No existing document, terminal, PWA, hub, or macOS workflow is removed.
