## Why

The Hub and each workspace session depend on a private agreement: how the Hub starts a session, how the session proves it is ready, which URLs and headers cross between them, and which session paths browsers must never reach. Nothing declares that agreement in one place. It is spread across `hub/backend.ts`, `hub/proxy.ts`, `hub/server.ts`, `cli.ts`, `server/routes.ts` and `shared/live-protocol.ts`, with hand-kept copies that already disagree in small ways: the ready-line regex exists three times, the `/s/<id>/` prefix is built five ways, two path-joining styles are in use, and the refused-stream regex in `hub/server.ts` repeats paths that `live-protocol.ts` already names. The session side also imports Hub modules (`server/routes.ts` and `cli.ts` import `hub/child-policy*`), so the dependency runs the wrong way. While collecting these facts we also found two internal routes that the Hub proxy forwards to browsers: `api/internal/hub-policy-proof` and `api/chat/accounts-changed`.

This change uses the terms **workspace session**, **session contract** and **session link** as defined in `GLOSSARY.md`.

## What Changes

- Add a server-only domain folder, `src/session-contract/`, that both the Hub and the workspace session import. It owns:
  - the spawn shape: the argv the Hub passes, the stdio layout, and the rule that the environment is passed explicitly;
  - the ready line (`http://127.0.0.1:<port><basePath>?t=<token>`), with one formatter and one parser;
  - exit when standard input closes;
  - the fd-3 policy bootstrap and the readiness proof (`POST <basePath>api/internal/hub-policy-proof`);
  - chat-policy signing and verification, including `CHILD_POLICY_HEADER` and the set of policy-signed actions;
  - the headers that cross the Hub hop: the `x-uatu-hub-*` strip rule, the operation-receipt header, the replay-resync header and the page-origin header;
  - the session base path `/s/<id>/` and joining paths onto it;
  - every internal session path the Hub calls, refuses, intercepts or treats specially, and the set of refused paths, which replaces the hand-copied `REFUSED_CHILD_STREAM_SUFFIXES` regex.
- Move minting of the session token (32 random bytes, base64url) out of `server/watch-session.ts` and into the session's serve assembly, through the contract. The document watcher no longer has an authentication role.
- `SessionBackend.start` yields a **session link** for each running workspace session. Hub code addresses and trusts a session only through its link: it builds tokened session URLs and signs chat policy there, while the contract's path classification decides which session paths the Hub refuses or intercepts. Hub code stops reading `RunningSession.token` and `policyTrust` directly, and the module-level `WeakMap` and `signSessionChatPolicy` in `hub/backend.ts` are removed.
- `server/routes.ts` keys its internal Hub-facing routes by contract constants. Public and browser routes stay literal. `api/route-coverage.test.ts` reads the contract constants.
- Add a test adapter, `tests/contracts/session-link.ts`, that builds a session link for a fake endpoint from the contract's own constructors, using real signing with a fixed secret, so the existing `SessionBackend` fakes stay small. It lives under `tests/` because `src/` holds product code only.
- Add one real-process contract test. It starts a real workspace session and checks every Hub expectation: the ready line, the fd-3 proof, that each internal path exists, that each refused path answers as the Hub expects, and that these paths stay out of the public contract.
- Make the E2E harness (`tests/e2e/server.ts`, `tests/e2e/hub-server.ts`, `tests/e2e/base-path.e2e.ts`) use the contract's formatter, parser and constants.
- Correct the `hub-service` spec so its spawn description matches what the code does today, and update `module-structure`, `CLAUDE.md` and `ARCHITECTURE.md` for the new folder and route rule.
- **Behaviour fix, in its own commit:** the Hub refuses browser requests for `api/internal/hub-policy-proof` and `api/chat/accounts-changed` instead of forwarding them to the session.

Everything except that last item is a pure restructure. Every path, flag, header, message and timeout stays the same. There is no API revision bump and no `api/CHANGELOG.md` entry. Any other drift found during the work is fixed in separate commits.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `module-structure`: add `session-contract/` to the folder map; restate the route-table rule so internal Hub-facing paths come from the session contract; require that session code does not import Hub modules and that the browser bundle never reaches the contract.
- `hub-service`: describe the session spawn as the code performs it today; describe a backend start as producing a session link; state that the Hub always injects a loopback `Origin`; add the refusal of the two internal routes; require a real-process test of the session contract.

## Impact

- **Code:** new `src/session-contract/`; `hub/backend.ts`, `hub/proxy.ts`, `hub/server.ts`, `hub/sessions.ts`, `hub/live-source.ts`, `hub/live-broker.ts`, `hub/notifications.ts`, `hub/worker-dismissals-api.ts`, `hub/agent-account-propagation.ts`; `hub/child-policy.ts` and `hub/child-policy-bootstrap.ts` move into the contract; `cli.ts`, `cli/parse.ts`, `cli/output.ts`, `server/routes.ts`, `server/watch-session.ts`, `terminal/auth.ts`, `terminal/sessions-route.ts`, `chat/notification-feed.ts`; the internal-path constants leave `shared/live-protocol.ts` and `shared/chat-operation-receipt.ts`.
- **Tests:** the existing `SessionBackend` fakes, `api/route-coverage.test.ts`, `terminal/token.test.ts`, `cli/stdin-close.test.ts`, `shared/browser-bundle-discipline.test.ts`, the E2E harness files, and one new real-process contract test.
- **Docs and specs:** `CLAUDE.md`, `ARCHITECTURE.md`, `openspec/specs/module-structure`, `openspec/specs/hub-service`. `api/exclusions.yaml` gains entries only for the fix commit.
- **Unchanged:** the public Hub API (`api/openapi.yaml`), live-topic payload schemas (`shared/live-protocol.ts` payloads, `shared/document-updates.ts`), credential environment content (`hub/credential-context.ts` keeps producing it; only the spawn shape that carries it is in scope), the base-path rules for browsers, and UatuCode Desktop, which uses only Hub APIs.
- **Release notes:** the restructure commits are not user-visible. The fix commit needs the release-note check from `CLAUDE.md`: if the forwarding exists in the latest stable `v*` tag it stays a visible `fix(...)`; otherwise it needs a Release Please override.
