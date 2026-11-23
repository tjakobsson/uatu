## Context

See proposal.md for why. This section lists the current code the design has to replace, checked against upstream main `133aefd`.

**Start and readiness.** `LocalProcessBackend.start` (`hub/backend.ts:102-212`) builds the spawn argv at `:103-119`, spawns with stdio `["pipe","pipe","pipe","socket-fd"]` and the environment from `buildLocalCredentialEnvironment` (`hub/credential-context.ts`). It sends the policy bootstrap over fd 3 (`hub/child-policy-bootstrap.ts`, marker `uatu-hub-private-bootstrap-v1\n`), then reads the ready line in `readFirstUrlLine` (`:220-271`, regex `/http:\/\/\S+/` at `:260`) with a 30 s inactivity timer (`STARTUP_INACTIVITY_TIMEOUT_MS`, `:64`), then posts a challenge to `${basePath}api/internal/hub-policy-proof` (`:190-203`, 2 s timeout). The session answers that route in `server/routes.ts:178-200` (500 ms read timeout, 1 KiB body cap). On the session side, `cli.ts:66-70` strips `--hub-policy-bootstrap` and calls `consumeChildPolicyDescriptor`; `cli.ts:446-466` implements stdin-close exit; `cli.ts:471-477` prints the ready line via `formatSessionUrl` (`cli/output.ts:21-27`). The 8192-byte bootstrap cap appears twice (`child-policy-bootstrap.ts:58`, `child-policy.ts:10`). Source-run detection (`/\.(ts|js)$/` on `Bun.argv[1]`) appears three times (`hub/backend.ts:81`, `cli/parse.ts:197`, `cli.ts:536`).

**Addressing and trust.** `childUrlFor` (`hub/proxy.ts:89-95`) overwrites `t` with `RunningSession.token`. `forwardedHeaders` (`proxy.ts:97-119`) drops hop-by-hop and `x-uatu-hub-*` caller headers and always sets a loopback `Origin`. Policy signing goes through `signSessionChatPolicy` and a module-level `WeakMap` in `hub/backend.ts:45-49`; `CHILD_POLICY_HEADER` is declared in `hub/child-policy.ts:5`, set at `proxy.ts:162` and read at `routes.ts:1336`. Other hop headers live in `shared/chat-operation-receipt.ts:5`, `shared/live-protocol.ts:144` (replay resync) and `terminal/auth.ts:92` (page origin, checked by the Hub at `hub/server.ts:1630`).

**Base path.** `/s/<id>/` is built or checked in five places: `hub/sessions.ts:19`, `hub/server.ts:174` (parse regex), `hub/server.ts:573` (template), `hub/agent-account-propagation.ts:29` (URI-encoded), and `hub/child-policy.ts:63` (session-side check). Paths are joined two ways: `${basePath}api/...` (`backend.ts`, `worker-dismissals-api.ts:31`) and `basePath.replace(/\/$/, "") + path` (`live-source.ts:24`).

**Internal paths.** The refused set is a regex in `hub/server.ts:179`, applied at `:1715`. Intercepts and special cases are spread across `proxy.ts` (`isLocalDiscardAction` `:41-44`, the media no-transform check `:230`, the snapshot tap `:235-260`) and `child-policy.ts:13-18` (policy-signed actions). The internal SSE paths are constants in `live-protocol.ts:125-134`, but `routes.ts:446`, `:820` and `:938` key three of them by literal.

**Session token.** `server/watch-session.ts:84` mints it and `:670` exposes it as `getTerminalToken`. `RunningSession.token` is typed `string | null`, although `cli.ts` always prints a token.

**Constraints that shape the design.**

- `src/` holds product code only, and the browser bundle must not import Node built-ins (`shared/browser-bundle-discipline.test.ts`). Some contract values are also used by the browser: the terminal client sends the page-origin header as a literal (`terminal/client.ts:392`), and browser code reaches `api/terminal/sessions`, `api/media` and the chat routes through `appUrl()`.
- Test helpers used by colocated tests already live under `tests/` (for example `tests/contracts/contract-harness.ts`, `tests/e2e/opencode-v2-fake.ts`).
- The untrusted mode of `tests/e2e/hub-server.ts` prints a ready line without a token and fetches it from `/__e2e/terminal-token` instead.

## Goals / Non-Goals

**Goals:**

- One server-only module declares the session contract. The Hub, the session's serve assembly and the E2E harness import it, and session code stops importing `src/hub/`.
- Hub code reaches a running session only through its session link.
- Every value on the wire stays byte-for-byte the same, except for the two refusals in the separate fix commit.

**Non-Goals:**

- Changing the credential environment's content or `hub/credential-context.ts` beyond where its output is handed to the spawn.
- Moving live-topic payload schemas, `shared/document-updates.ts`, or anything published in `api/openapi.yaml`.
- Tightening behaviour that looks loose but is current. For example, the parser keeps accepting a ready line without `t`, and the link keeps a nullable token (see Open Questions).
- Changing `cli/parse.ts`'s import of `hub/config` for the `uatu hub` command. That is CLI dispatch, not the session contract.

## Decisions

### 1. `src/session-contract/` is a domain folder split by concern

Proposed files (names may change during implementation; the split may not):

- `spawn.ts`: the serve argv builder, stdio layout, source-run detection, ready-line formatter and parser, startup inactivity constant.
- `bootstrap.ts`: the fd-3 readiness marker, size cap, send and consume functions (moved from `hub/child-policy-bootstrap.ts`), and `verifyPolicyReadiness`, the Hub's challenge to the proof route. The challenge is sent before the link exists and, as today, without the session token.
- `policy.ts`: the policy authority and verifier, `CHILD_POLICY_HEADER`, the policy-signed action matcher and `CHAT_ACTION_BODY_BYTES` (moved from `hub/child-policy.ts`). The moved functions keep their names (`createChildPolicyAuthority`, `readChildPolicyBootstrap`, `isChildPolicyAction`), so their tests change only in import paths; new contract identifiers use the glossary's "session" (`SESSION_*`).
- `paths.ts`: `sessionBasePath(id)`, one `sessionPath(basePath, relative)` join, the internal path constants, and `classifySessionPath(method, suffix)`.
- `headers.ts`: the `x-uatu-hub-` prefix and strip rule, the operation-receipt, replay-resync and page-origin header names.
- `token.ts`: `mintSessionToken()` (32 random bytes, base64url).
- `link.ts`: the `SessionLink` type and `createSessionLink`.

It may use `node:crypto` and `node:net`. Nothing reachable from `src/app.ts` may import it. The existing browser-bundle discipline test gains an explicit assertion for the folder, since a pure-TypeScript contract file would otherwise pass the Node-built-in check unnoticed.

*Alternative rejected:* putting the contract in `src/shared/`. `shared/` is reachable from the browser and holds client/server DTOs. A server-only seam there would rely on discipline alone to stay out of the bundle.

*Alternative rejected:* leaving the code in `src/hub/` and letting the session import it. That is today's arrangement, and it makes the session depend on the Hub.

### 2. A session link replaces direct reads of `RunningSession` fields

`SessionBackend.start` returns `RunningSession = { link, exited, stop }`. `SessionLink` exposes:

- `workspaceId`, `instanceId`, `basePath`, `endpoint`, `origin`;
- `policyTrust` (read-only; `"ready"` or `"unavailable"`);
- `url(relativePath | requestUrl)`: the session URL with `t` overwritten. This replaces `childUrlFor`;
- `requestHeaders(accept)`: loopback `Host` and `Origin`, plus identity encoding. This replaces `childRequestHeaders`;
- `forwardHeaders(request)`: the proxied-request header shaping now in `forwardedHeaders`;
- `sign(request, policy)`: returns `string | null`, exactly as `signSessionChatPolicy` does today;
- `withdraw()`: called by the backend on stop or exit. It clears trust and disposes the key.

The policy authority lives inside the link's closure, so the `WeakMap` in `hub/backend.ts` goes away. The per-session `degradedReceipts` `WeakMap` in `proxy.ts` is Hub state rather than contract and stays, keyed by the link.

Callers move to the link: `hub/proxy.ts` (HTTP and WebSocket bridge), `hub/live-source.ts`, `hub/worker-dismissals-api.ts`, the dashboard's terminal-sessions call at `hub/server.ts:573`, and `hub/agent-account-propagation.ts`. `hub/sessions.ts` keeps its map of `RunningSession` and its lifecycle chain unchanged.

*Alternative rejected:* keeping `RunningSession` flat and adding helper functions. That keeps the token and trust as readable fields, which is the coupling this change removes.

### 3. One path classifier replaces the refused-stream regex and the scattered intercepts

`classifySessionPath(method, suffix)` returns one of:

- `refused-stream`: answered 410 with the brokered-stream replacement;
- `refused-internal`: answered 404, added only in the fix commit;
- `local-discard`;
- `policy-action`;
- `conversation-snapshot` (GET, eligible for the bounded observation tap);
- `media` (no-transform);
- `forward`.

`hub/server.ts` and `hub/proxy.ts` branch on the result. The Hub classifies the suffix it parsed off the request path for the refusal, and the path under the running session's base path (`classifySessionRequest`) for the intercepts, exactly as the two checks were scoped before. Only routes the Hub alone calls are keyed by contract constants in `server/routes.ts`; the browser routes the Hub intercepts (media, the conversation snapshot, discard and the policy actions) stay literal there, and `api/route-coverage.test.ts` pins that the classifier still matches the registered shapes. Routes the Hub serves itself under `/s/<id>/` (`api/personal-state`, `api/activity-viewed`, worker dismissals) are part of the Hub API and stay in `hub/server.ts`. The refused-stream set is derived from the same constants `server/routes.ts` registers, so the hand-copied regex cannot drift again. The internal SSE path constants, the SSE event names `activity` and `open`, and the replay-resync header move from `shared/live-protocol.ts` to the contract. Only the session and the Hub read them. `live-protocol.ts` keeps the public live stream and its payloads. The `CHILD_NOTIFICATIONS_PATH` re-export in `chat/notification-feed.ts` is removed, and its importers use the contract.

### 4. Browser code keeps its own literals for shared paths

The contract cannot be imported by the browser, so browser code keeps reaching `api/terminal/sessions`, `api/media` and chat routes through `appUrl("…")` literals, and `terminal/client.ts` keeps its `X-Uatu-Page-Origin` literal. Server code imports the header name from the contract instead of from `terminal/auth.ts`. A unit test asserts that the client literal equals the contract constant, which tests may import.

### 5. The serve assembly mints the session token

`cli.ts` calls `mintSessionToken()` once, then passes the token both to `buildRoutes`/`buildFetchFallback` deps and to the ready-line formatter. `tests/e2e/server.ts` mints through the contract too, but once per watch session: its `/__e2e/reset` replaces the watch session, and tests rely on that rotating the workspace credential, which is what `createWatchSession` minting gave it. The harness's `/__e2e/terminal-token` route reads the same value from the route deps (`getWorkspaceCredential`). `createWatchSession` loses `getTerminalToken`. `terminal/token.test.ts` becomes the contract's token test and keeps its assertions: 32 bytes, base64url, distinct per call. Route deps keep the name `getTerminalToken` so route code does not change.

### 6. The test adapter lives under `tests/`, on top of product constructors

`src/` holds product code only, so the adapter is `tests/contracts/session-link.ts`, which colocated tests import as they already import `tests/contracts/contract-harness.ts`. It builds a real link for a fake endpoint: `createSessionLink` with a policy authority built from a fixed secret and instance id, plus the matching verifier so tests can check what the session would accept. For that, the product `createPolicyAuthority` accepts optional `secret` and `instanceId` inputs. Production never passes them. This is a small deviation from the agreed wording ("the contract exports a test adapter"): the contract exports the constructors, and the adapter sits next to the other test harnesses.

### 7. The real-process contract test runs one session behind an in-process Hub

`src/session-contract/session.integration.test.ts` spawns `bun run src/cli.ts serve <tmp> …` with the contract's argv through `LocalProcessBackend`, which also exercises fd 3 and the proof. It runs the Hub's fetch handler in front of it to observe refusals. It waits on events only: the ready line, the proof response, each HTTP answer, and process exit after stdin closes. It checks every internal path from the contract's list (exists on the direct listener), every `refused-stream` path (410 through the Hub, including `/api/chat/notifications/events`), and that each one is classified by `api/exclusions.yaml`. The fix commit extends the same loop to the `refused-internal` paths. Existing integration tests stay. The test has its own entry in `tests/unit-timings.json` if its runtime warrants it.

### 8. Commit order inside one PR

The commits, in order:

1. This OpenSpec change.
2. The contract module and its consumers (restructure).
3. The real-process contract test.
4. The fix: refuse `api/internal/hub-policy-proof` and `api/chat/accounts-changed` through the Hub, with explicit `api/exclusions.yaml` entries.

A grep of `src/` finds no browser caller of either route; the Hub reaches both directly over loopback (`hub/backend.ts:193`, `hub/agent-account-propagation.ts:29`), so the fix removes nothing a page uses. The 404 status was chosen because these are not streams with a replacement. A 410 would wrongly suggest one. A preliminary check found `api/chat/accounts-changed` already forwarded in `v0.8.0`, the latest stable tag, while `hub-policy-proof` was added after it. If the task confirms this, the fix stays a visible `fix(hub): …` entry with no Release Please override.

## Risks / Trade-offs

- [A moved constant changes a byte on the wire] → The contract test and the existing integration tests run against a real session. Constants are moved, not retyped, and the diff for each constant is reviewed as a move.
- [Some test fakes construct `RunningSession` objects with `token: null` or hand-written fields] → The adapter covers both trust states. Fakes that rely on a null token keep working, because the link keeps a nullable token.
- [Classifier ordering changes which branch wins for an overlapping path] → `hub/server.ts` keeps its current order: Hub-served routes, then refused, then running check, upgrade, discard, policy action, forward. A unit table test pins the classifier's answer for every current path.
- [The browser keeps literals the contract also declares] → This is a bounded duplication, forced by the bundle boundary. The equality test covers the header. Paths are covered by the existing route and E2E suites.
- [The fix is a behaviour change inside a restructure PR] → It is a separate commit with its own spec scenario and release-note decision, so it can be reverted alone.

## Migration Plan

No data or configuration migration. The Hub and its sessions ship in the same build, so no mixed-version compatibility is needed. The contract test and the unchanged `hub/backend.integration.test.ts` guard against a mismatch. Rollback is a revert of the commits.

## Open Questions

- Should a later change make the ready line's token mandatory and the link's token non-null? Today it is always present from `cli.ts`, but the untrusted E2E harness mode prints an untokened line. This is deferred because it changes behaviour for a case production never produces.
