# OpenCode Chat

OpenCode Chat is a workspace-scoped web client for an existing OpenCode
installation. It does not bundle OpenCode, configure a model provider, or hold
provider credentials.

## Prerequisites

1. Install a compatible `opencode` executable by following the
   [OpenCode installation guide](https://opencode.ai/docs/).
2. Run `opencode` as the same operating-system user that runs `uatu`.
3. In OpenCode, use `/connect` to authenticate a provider and `/models` to
   choose a model. Confirm a normal OpenCode prompt works before using Chat.
4. Ensure `opencode --version` succeeds in the environment that starts the
   uatu hub or direct server. A service manager may have a different
   `PATH`, `HOME`, or provider environment from an interactive shell.

OpenCode owns its configuration, provider authentication, and durable session
history. uatu never asks for, copies, transmits, or stores provider API
keys. UatuCode Desktop's Keychain contains only hub login credentials and hub
session identifiers, not OpenCode or model-provider secrets.

## Lifecycle And Workspace

Opening Chat lazily starts one password-protected OpenCode server bound to an
ephemeral `127.0.0.1` port inside that uatu workspace process. The private
endpoint and password are never sent to a browser or exposed by the hub.

The canonical first watched root is the immutable OpenCode working directory.
For a direct multi-root command, later roots remain available to Preview but
Chat uses only the first root. Browser requests cannot select another working
directory, and conversations belonging to another canonical directory are not
listed or accepted.

Stopping the uatu workspace stops its OpenCode child and any active turn.
Completed OpenCode history remains in OpenCode's own storage and is available
when the workspace starts again. Closing a browser, PWA, or UatuCode Desktop
window does not stop a hub workspace.

## Access And Authority

Direct `uatu serve` access uses the same short-lived workspace credential and
HttpOnly cookie as the embedded terminal. Chat reads and mutations require that
credential, and mutations also require a same-origin request.

With `uatu hub`, users authenticate to the hub. The hub brokers the child
workspace credential and proxies Chat HTTP and SSE traffic under
`/s/<workspace-id>/`; it does not expose the loopback OpenCode endpoint. Hub
users share the authority of the operating-system account running the hub.

An OpenCode agent can read files, execute commands, and modify anything that
the daemon's OS user can access. uatu workspace membership and OpenCode
permission prompts are not an OS sandbox. Do not give mutually untrusted users
access to one hub account or daemon user. See [Self-hosting](./SELF-HOSTING.md)
for the complete trust model and network guidance.

## Troubleshooting

- **OpenCode is not installed:** `opencode` was not found on the server
  process's `PATH`. Verify it from the service account and restart the
  workspace after correcting `PATH`.
- **OpenCode could not start:** run `opencode serve --hostname 127.0.0.1
  --port 0` as the daemon user and inspect its diagnostic. Check executable
  permissions, configuration syntax, and service-manager environment.
- **Installed version is not compatible:** upgrade OpenCode, then restart the
  uatu workspace. uatu validates SDK responses rather than exposing
  unknown provider payloads.
- **A prompt fails or no model is available:** run OpenCode directly, repeat
  `/connect` and `/models`, and verify the provider account. Provider failures
  do not disable Preview, Files, Search, or Terminal.
- **A conversation is missing:** sessions are filtered to the canonical first
  root. Confirm OpenCode created the session in exactly that workspace.
- **Chat reconnects or requests resync:** a brief disconnect replays retained
  events. A workspace restart or a long retention gap requires a fresh history
  snapshot automatically; completed OpenCode history is not deleted.
- **Hub Chat is unauthorized:** sign in again and verify the workspace is
  running. Do not proxy a child session directly or rewrite its base path.

## Scope

This integration is OpenCode-only. It does not implement ACP, Claude Code,
Codex, session sharing/fork/revert, image attachments, or a native SwiftUI chat
renderer. Other providers may be added later behind uatu's normalized API;
OpenCode's own provider support remains configured and authenticated through
OpenCode today.

Chat does surface the models OpenCode already has configured, so a conversation
can pick among them, and it offers OpenCode's own slash commands. Neither adds
a provider or credential of its own: authentication stays in OpenCode.
