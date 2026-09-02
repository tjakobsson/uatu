// Shared Bun.serve route table used by both the production CLI server
// (cli.ts) and the e2e test harness server (tests/e2e/server.ts). Twelve
// of the fourteen routes are identical between the two; the rest are gated
// on the `mode` discriminator below.
//
// This module is the single home for the HTTP surface: the static route
// table (`buildRoutes`) plus the catch-all fetch fallback
// (`buildFetchFallback`) that handles the terminal WebSocket upgrade,
// `/api/auth`, the terminal-sessions inventory, and navigation dispatch.
// Both server entry points obtain both pieces here with mode-specific deps.

import type { Serve } from "bun";

import { ChatQueueFullError, CommandAttachmentsError, ConversationRenameUnsupportedError, InteractionConflictError, InvalidConversationTitleError, InvalidModeSelectionError, InvalidModelSelectionError, InvalidPermissionChoiceError, InvalidVariantSelectionError, QueuedMessageNotHeldError, ReversibleHistoryUnsupportedError, UnknownAttachmentError } from "../chat/adapter";
import { AttachmentStoreError } from "../chat/attachment-store";
import { BackgroundTaskUnavailableError, InvalidQuestionAnswerError, ReversibleHistoryTargetError } from "../chat/provider";
import { encodeReplayCursor } from "../chat/replay";
import { ChatUnavailableError } from "../chat/service";
import { UnknownAgentError, type MultiAgentWorkspaceChatService } from "../chat/agents";
import { CHAT_ATTACHMENT_MAX_BYTES, CHAT_ATTACHMENT_MIME_TYPES, CHAT_ATTACHMENTS_PER_MESSAGE, type MessageAttachment, type ModelSelection, type PermissionOutcome, type QuestionOutcome } from "../chat/types";
import { ConversationNotFoundError } from "../chat/workspace";
import { getDocumentDiff } from "../document/diff";
import { collectFileFacts } from "../document/file-facts";
import {
  authProbeResponse,
  constantTimeEqual,
  formatTerminalCookie,
  hasValidTerminalCredentials,
  hasValidWorkspaceCredentials,
  isAllowedOrigin,
} from "../terminal/auth";
import type { createTerminalServer } from "../terminal/server";
import { handleTerminalSessionsRoute } from "../terminal/sessions-route";
import { joinBasePath, stripBasePath } from "../shared/base-path";
import { findDocument, isViewMode } from "../shared/types";
import { parseWatchContext, type WatchContext } from "../shared/watch-context";
import { renderDocument } from "./render-dispatch";
import { buildSearchPattern, searchDocuments } from "./search";
import type { WatchSession } from "./watch-session";

// Bun.serve's idleTimeout. 0 = disabled: SSE connections and long-lived
// terminal WebSockets must never be reaped by an idle timer.
export const SERVE_IDLE_TIMEOUT_SECONDS = 0;

export type RouteAssets = {
  // The HTML entry (`import index from "./index.html"`) is intentionally
  // NOT here. `Bun.serve`'s bundler analyzes the route literal at the call
  // site to detect HTMLBundle entries and emit their chunk URLs into the
  // compiled binary. If the HTMLBundle is reached through a function-call
  // indirection (like `buildRoutes(...)`), the bundler can't see it and
  // the chunks fail to serve in compiled mode. So `"/": index` stays
  // inline at the Bun.serve call site; only the remaining assets are
  // routed through this builder.
  //
  // The remaining assets are file *paths* produced by `import x from "…"
  // with { type: "file" }`. They're served via `Bun.file(path)`.
  mermaid: string;
  logo: string;
  icon192: string;
  icon512: string;
  manifest: string;
  // Bundled web fonts. Same `with { type: "file" }` mechanism — the
  // strings here are file paths embedded in the compiled binary, served
  // as woff2 (or plain text for the license/notice siblings).
  fonts: {
    hackMono: string;
    hackLicense: string;
    nerdFontsLicense: string;
    notices: string;
  };
};

type BaseDeps = {
  assets: RouteAssets;
  // Factory rather than direct reference: the e2e harness re-creates the
  // session on every `/__e2e/reset`, so the routes must read through to the
  // current instance each time they're invoked.
  getSession: () => WatchSession;
  // Mandatory injection keeps production and E2E on the same public route
  // table while allowing the test harness to use a deterministic provider.
  chatService: MultiAgentWorkspaceChatService;
  getWorkspaceCredential: () => string;
  // Normalized base-path prefix (leading + trailing "/"). Every static
  // route key is served under it; "/" (the default) is the identity.
  basePath?: string;
  // Who owns the origin. "base-path" (the default) confines the manifest's
  // `scope` to the base path — right for a generic `--base-path` mount on a
  // shared domain. "origin" widens `scope` to "/" while start_url and icons
  // stay relocated: a hub-served session declares the whole hub origin
  // (dashboard, login, sibling sessions) as in-app, so an installed webapp
  // never shows iOS's out-of-scope browser chrome navigating between them.
  manifestScope?: "base-path" | "origin";
};

export type ProdRouteDeps = BaseDeps & {
  mode: "prod";
  // `/debug/metrics` returns 404 unless --debug was passed; the snapshot
  // function is only consulted when `debug` is true.
  debug: boolean;
  getMetricsSnapshot: () => unknown;
};

export type E2ERouteDeps = BaseDeps & {
  mode: "e2e";
  // The reset handler mutates module-level state in tests/e2e/server.ts
  // (active file path, workspace root, follow mode, etc.) and re-creates
  // the watch session, so it stays a callback owned by the caller.
  handleE2EReset: (request: Request) => Promise<Response>;
  // The production endpoint is Hub-owned. The direct-child Playwright
  // harness supplies an in-memory equivalent so resume behavior is testable.
  handleE2EPersonalState: (request: Request) => Promise<Response>;
  handleE2EChat: (request: Request) => Promise<Response>;
};

export type BuildRoutesDeps = ProdRouteDeps | E2ERouteDeps;

// Explicit return type: the prod/e2e conditional otherwise makes this a
// union of two route tables, which Bun.serve's `Routes` generic rejects when
// the result is spread at the call sites.
export function buildRoutes(deps: BuildRoutesDeps): Serve.Routes<unknown, string> {
  const { assets, getSession } = deps;
  const basePath = deps.basePath ?? "/";
  const manifestScope = deps.manifestScope ?? "base-path";
  // Static route keys are data to Bun.serve, so prefixing them is enough to
  // move the whole HTTP surface under the base path. (The HTMLBundle route
  // stays a literal at each Bun.serve call site — see RouteAssets.)
  const p = (path: string) => joinBasePath(basePath, path);

  const requestContext = (request: Request): WatchContext | Response => {
    const parsed = parseWatchContext(new URL(request.url).searchParams);
    if ("error" in parsed) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }
    return parsed.context;
  };

  const chat = buildChatRoutes(deps, p);

  const modeRoutes =
    deps.mode === "prod"
      ? buildProdRoutes(deps, p)
      : buildE2ERoutes(deps, p);

  return {
    [p("/assets/mermaid.min.js")]: new Response(Bun.file(assets.mermaid), {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
      },
    }),
    [p("/assets/uatu-logo.svg")]: new Response(Bun.file(assets.logo), {
      headers: {
        "content-type": "image/svg+xml",
        "cache-control": "public, max-age=3600",
      },
    }),
    [p("/assets/icon-192.png")]: new Response(Bun.file(assets.icon192), {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400",
      },
    }),
    [p("/assets/icon-512.png")]: new Response(Bun.file(assets.icon512), {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400",
      },
    }),
    // Under a base path the manifest's root-absolute members (start_url,
    // scope, icon srcs) must relocate with the session, so it is rewritten
    // per-request; at "/" the bundled file serves untouched.
    [p("/manifest.webmanifest")]:
      basePath === "/"
        ? new Response(Bun.file(assets.manifest), {
            headers: {
              "content-type": "application/manifest+json",
              "cache-control": "public, max-age=3600",
            },
          })
        : {
            GET: async () => {
              const manifest = (await Bun.file(assets.manifest).json()) as {
                start_url?: string;
                scope?: string;
                icons?: { src?: string }[];
              };
              if (typeof manifest.start_url === "string") {
                manifest.start_url = joinBasePath(basePath, manifest.start_url);
              }
              if (typeof manifest.scope === "string") {
                // Origin mode: the hub owns its origin root, so the session
                // app's scope is the whole hub — see BaseDeps.manifestScope.
                manifest.scope = manifestScope === "origin" ? "/" : joinBasePath(basePath, manifest.scope);
              }
              for (const icon of manifest.icons ?? []) {
                if (typeof icon.src === "string" && icon.src.startsWith("/")) {
                  icon.src = joinBasePath(basePath, icon.src);
                }
              }
              return Response.json(manifest, {
                headers: {
                  "content-type": "application/manifest+json",
                  "cache-control": "public, max-age=3600",
                },
              });
            },
          },
    [p("/assets/fonts/HackNerdFontMono-Regular.woff2")]: new Response(Bun.file(assets.fonts.hackMono), {
      headers: {
        "content-type": "font/woff2",
        // Immutable: the file is part of the compiled binary and only
        // changes on a new uatu release.
        "cache-control": "public, max-age=31536000, immutable",
      },
    }),
    [p("/assets/fonts/LICENSE-hack.md")]: new Response(Bun.file(assets.fonts.hackLicense), {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    }),
    [p("/assets/fonts/LICENSE-nerdfonts.txt")]: new Response(Bun.file(assets.fonts.nerdFontsLicense), {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    }),
    [p("/assets/fonts/NOTICES.md")]: new Response(Bun.file(assets.fonts.notices), {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    }),
    [p("/api/state")]: {
      GET: (request: Request) => {
        const context = requestContext(request);
        return context instanceof Response
          ? context
          : Response.json(getSession().getStatePayload(null, context));
      },
    },
    [p("/api/document")]: {
      GET: async (request: Request) => {
        const url = new URL(request.url);
        const context = requestContext(request);
        if (context instanceof Response) return context;
        const documentId = url.searchParams.get("id");
        if (!documentId) {
          return Response.json({ error: "missing document id" }, { status: 400 });
        }

        const rawView = url.searchParams.get("view");
        const view = rawView && isViewMode(rawView) ? rawView : undefined;

        try {
          const document = await renderDocument(getSession().getRoots(context), documentId, { view });
          return Response.json(document);
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (message === "document is binary") {
            return Response.json({ error: "document is not viewable" }, { status: 415 });
          }
          return Response.json({ error: "document not found" }, { status: 404 });
        }
      },
    },
    [p("/api/document/diff")]: {
      GET: async (request: Request) => {
        const url = new URL(request.url);
        const context = requestContext(request);
        if (context instanceof Response) return context;
        const documentId = url.searchParams.get("id");
        if (!documentId) {
          return Response.json({ error: "missing document id" }, { status: 400 });
        }

        try {
          const roots = getSession().getRoots(context);
          const payload = await getDocumentDiff(
            roots,
            documentId,
            context.compareTarget,
          );
          // Attach file facts so a diff-first load (the /api/document payload
          // was never fetched) can still populate the facts strip's
          // author/sha segments.
          const doc = findDocument(roots, documentId);
          const rootPath = doc ? roots.find(root => root.id === doc.rootId)?.path : undefined;
          const fileFacts = doc && rootPath
            ? await collectFileFacts({ absolutePath: doc.id, rootPath })
            : undefined;
          return Response.json({ ...payload, ...(fileFacts ? { fileFacts } : {}) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (message === "document not found") {
            return Response.json({ error: "document not found" }, { status: 404 });
          }
          return Response.json({ error: "document diff failed" }, { status: 500 });
        }
      },
    },
    [p("/api/events")]: {
      GET: (request: Request) => {
        const context = requestContext(request);
        return context instanceof Response ? context : getSession().eventsResponse(context);
      },
    },
    [p("/api/search")]: {
      // Content search across the watched roots. Streams NDJSON — one JSON
      // object per line — rather than buffering the whole sweep: on a docs
      // tree the difference is imperceptible, but pointed at a repository it
      // is the difference between a pane that fills and one that hangs.
      //
      // The corpus is the session's own root groups, so `.gitignore`,
      // `.uatu.json`, binary classification, and the active scope all apply
      // without being reimplemented here.
      GET: (request: Request) => {
        const url = new URL(request.url);
        const context = requestContext(request);
        if (context instanceof Response) return context;
        const query = url.searchParams.get("q") ?? "";
        const options = {
          caseSensitive: url.searchParams.get("case") === "1",
          wholeWord: url.searchParams.get("word") === "1",
          regex: url.searchParams.get("regex") === "1",
        };

        // Reject an unusable pattern before starting a sweep, so the client
        // gets a reportable error rather than an empty result set that looks
        // like "no matches".
        const pattern = buildSearchPattern(query, options);
        if ("error" in pattern) {
          return Response.json({ error: pattern.error }, { status: 400 });
        }

        // `allRoots` is the escape hatch for a scope narrowed so far that
        // search would otherwise be useless — a single-file scope most of all.
        const roots =
          url.searchParams.get("allRoots") === "1"
            ? getSession().getUnscopedRoots()
            : getSession().getRoots(context);

        // A superseded query aborts its fetch, but that alone only stops the
        // browser-side consumer — a no-match sweep yields nothing until its
        // final `done`, so without propagation it would keep reading and
        // matching the whole corpus for a reader that is gone. The abort
        // reaches us on two channels depending on timing — `request.signal`
        // when the runtime notices the disconnect, stream `cancel` when the
        // consumer stops reading — so both feed one controller the sweep
        // watches.
        const sweep = new AbortController();
        const stopSweep = () => sweep.abort();
        request.signal.addEventListener("abort", stopSweep, { once: true });

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              for await (const event of searchDocuments(
                roots,
                query,
                options,
                undefined,
                undefined,
                sweep.signal,
              )) {
                controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
              }
            } catch {
              // A sweep that dies mid-flight closes the stream; the client
              // reports what it received rather than hanging on more.
            } finally {
              request.signal.removeEventListener("abort", stopSweep);
              try {
                controller.close();
              } catch {
                // Already cancelled by the consumer.
              }
            }
          },
          cancel: stopSweep,
        });

        return new Response(stream, {
          headers: {
            "cache-control": "no-cache",
            "content-type": "application/x-ndjson; charset=utf-8",
          },
        });
      },
    },
    ...chat,
    ...modeRoutes,
  };
}

const CHAT_ID_LIMIT = 512;
const CHAT_CURSOR_LIMIT = 2_048;
const CHAT_PROMPT_BYTES = 64 * 1024;
const CHAT_TITLE_BYTES = 200;
const CHAT_BODY_BYTES = 128 * 1024;
const CHAT_KEEPALIVE_MS = 15_000;
const CHAT_ATTACHMENT_NAME_BYTES = 200;
// Multipart framing around the one file field: boundaries, headers, the
// filename. Generous because it only pre-screens the declared length.
const CHAT_ATTACHMENT_FORM_OVERHEAD_BYTES = 16 * 1024;

type RouteRequest = Request & { params?: Record<string, string> };

function buildChatRoutes(deps: BuildRoutesDeps, p: (path: string) => string) {
  const authenticated = (request: Request): Response | null => {
    const url = new URL(request.url);
    return hasValidWorkspaceCredentials(request, url, deps.getWorkspaceCredential())
      ? null
      : chatError(401, "authentication required");
  };
  const mutationGate = (request: Request): Response | null => {
    const auth = authenticated(request);
    if (auth) return auth;
    return isAllowedOrigin(request.headers.get("origin"), new URL(request.url))
      ? null
      : chatError(403, "cross-origin request rejected");
  };
  // Catalog reads describe one agent; an unscoped read has no answer that is
  // not a guess, so the parameter is required rather than defaulted.
  const withAgentScope = (request: Request, operation: (agentId: string) => Promise<Response>): Promise<Response> | Response => {
    const agentId = new URL(request.url).searchParams.get("agent");
    if (!agentId) return chatError(400, "agent query parameter is required");
    return operation(agentId);
  };
  const run = async (operation: () => Promise<unknown>, status = 200): Promise<Response> => {
    try {
      return Response.json(await operation(), { status, headers: { "cache-control": "no-store" } });
    } catch (error) {
      return normalizedChatError(error);
    }
  };

  return {
    [p("/api/chat/status")]: {
      GET: async (request: Request) => authenticated(request) ?? run(async () => ({
        agents: await deps.chatService.status(),
      })),
    },
    // POST, not a query on /status: retry spawns a process, so it must not sit
    // behind a safe method — and it takes the mutation gate, because a
    // same-site page riding the workspace cookie must not be able to spawn
    // OpenCode either.
    [p("/api/chat/retry")]: {
      POST: async (request: Request) => {
        const rejected = mutationGate(request);
        if (rejected) return rejected;
        const body = await parseJsonObject(request, ["agentId"]);
        if (body instanceof Response) return body;
        if (typeof body.agentId !== "string" || !body.agentId) return chatError(400, "agentId must be a non-empty string");
        return run(() => deps.chatService.retry(body.agentId as string));
      },
    },
    [p("/api/chat/models")]: {
      GET: async (request: Request) => authenticated(request) ?? withAgentScope(request, agentId => run(async () => ({
        models: await deps.chatService.models(agentId),
      }))),
    },
    [p("/api/chat/modes")]: {
      GET: async (request: Request) => authenticated(request) ?? withAgentScope(request, agentId => run(async () => ({
        modes: await deps.chatService.modes(agentId),
      }))),
    },
    [p("/api/chat/commands")]: {
      GET: async (request: Request) => authenticated(request) ?? withAgentScope(request, agentId => run(async () => ({
        commands: await deps.chatService.commands(agentId),
      }))),
    },
    [p("/api/chat/conversations")]: {
      GET: async (request: Request) => authenticated(request) ?? run(async () => ({
        conversations: await deps.chatService.listConversations(),
      })),
      POST: async (request: Request) => {
        const rejected = mutationGate(request);
        if (rejected) return rejected;
        const body = await parseJsonObject(request, ["agentId"]);
        if (body instanceof Response) return body;
        if (body.agentId !== undefined && (typeof body.agentId !== "string" || !body.agentId)) {
          return chatError(400, "agentId must be a non-empty string");
        }
        return run(() => deps.chatService.createConversation(body.agentId as string | undefined), 201);
      },
    },
    // Static route must precede the conversation identity route so "events"
    // is never interpreted as a conversation id.
    [p("/api/chat/conversations/events")]: {
      GET: async (request: Request) => {
        const rejected = authenticated(request);
        if (rejected) return rejected;
        const abort = new AbortController();
        const onAbort = () => abort.abort();
        if (request.signal.aborted) abort.abort();
        else request.signal.addEventListener("abort", onAbort, { once: true });
        try {
          const events = await deps.chatService.subscribeInventory({ signal: abort.signal });
          const encoder = new TextEncoder();
          const iterator = events[Symbol.asyncIterator]();
          let pending: Promise<IteratorResult<void>> | null = null;
          let finished = false;
          const finish = async () => {
            if (finished) return;
            finished = true;
            await iterator.return?.().catch(() => undefined);
            events.cancel();
            request.signal.removeEventListener("abort", onAbort);
          };
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                pending ??= iterator.next();
                const result = await nextChatEvent(pending, CHAT_KEEPALIVE_MS);
                if (result === "keepalive") {
                  controller.enqueue(encoder.encode(": keepalive\n\n"));
                  return;
                }
                pending = null;
                if (!result.done) {
                  controller.enqueue(encoder.encode('event: inventory\ndata: {"type":"conversation.inventory"}\n\n'));
                  return;
                }
              } catch {
                // Cancellation closes the transport without an in-band error.
              }
              await finish();
              try { controller.close(); } catch { /* consumer cancelled */ }
            },
            cancel() {
              abort.abort();
              return finish();
            },
          }, { highWaterMark: 0 });
          return new Response(stream, {
            headers: {
              "cache-control": "no-store, no-transform",
              "content-type": "text/event-stream; charset=utf-8",
              "x-accel-buffering": "no",
            },
          });
        } catch (error) {
          request.signal.removeEventListener("abort", onAbort);
          return normalizedChatError(error);
        }
      },
    },
    [p("/api/chat/conversations/:conversationId")]: {
      GET: async (request: RouteRequest) => {
        const rejected = authenticated(request);
        if (rejected) return rejected;
        const id = routeIdentity(request, "conversationId");
        if (id instanceof Response) return id;
        const url = new URL(request.url);
        const cursor = optionalBounded(url.searchParams.get("cursor"), "cursor", CHAT_CURSOR_LIMIT);
        if (cursor instanceof Response) return cursor;
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? undefined : Number(rawLimit);
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
          return chatError(400, "limit must be an integer from 1 to 100");
        }
        return run(() => deps.chatService.history(id, { cursor, limit }));
      },
      PATCH: async (request: RouteRequest) => chatMutation(request, ["requestId", "title"], async (id, body) => {
        const requestId = bodyIdentity(body, "requestId");
        if (requestId instanceof Response) return requestId;
        if (typeof body.title !== "string") return chatError(400, "title must be a string");
        const title = body.title.trim();
        if (!title) return chatError(400, "title must not be empty");
        if (Buffer.byteLength(title) > CHAT_TITLE_BYTES) return chatError(400, "title is too large");
        return run(() => deps.chatService.renameConversation(id, requestId, title));
      }),
    },
    [p("/api/chat/conversations/:conversationId/events")]: {
      GET: async (request: RouteRequest) => {
        const rejected = authenticated(request);
        if (rejected) return rejected;
        const id = routeIdentity(request, "conversationId");
        if (id instanceof Response) return id;
        const url = new URL(request.url);
        const cursor = optionalBounded(
          url.searchParams.get("cursor") ?? request.headers.get("last-event-id"),
          "cursor",
          CHAT_CURSOR_LIMIT,
        );
        if (cursor instanceof Response) return cursor;
        const abort = new AbortController();
        const onAbort = () => abort.abort();
        request.signal.addEventListener("abort", onAbort, { once: true });
        try {
          const { events } = await deps.chatService.subscribe(id, { cursor, signal: abort.signal });
          const encoder = new TextEncoder();
          const iterator = events[Symbol.asyncIterator]();
          let pending = iterator.next();
          let finished = false;
          const finish = async () => {
            if (finished) return;
            finished = true;
            await iterator.return?.().catch(() => undefined);
            events.cancel();
            request.signal.removeEventListener("abort", onAbort);
          };
          // Pull-driven, one frame per pull: a slow or stalled client stops
          // pulling and the loop stops consuming — a push loop here buffered
          // an unbounded queue inside the ReadableStream for as long as an
          // active agent kept publishing.
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                while (!abort.signal.aborted) {
                  const result = await nextChatEvent(pending, CHAT_KEEPALIVE_MS);
                  if (result === "keepalive") {
                    controller.enqueue(encoder.encode(": keepalive\n\n"));
                    return;
                  }
                  if (result.done) break;
                  pending = iterator.next();
                  const event = result.value;
                  const eventId = encodeReplayCursor({ generation: event.generation, sequence: event.sequence });
                  const eventName = event.type === "resync" ? "resync" : "chat";
                  controller.enqueue(encoder.encode(`id: ${eventId}\nevent: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`));
                  if (event.type !== "resync") return;
                  break;
                }
              } catch {
                // A transport cancellation closes the stream without inventing
                // an in-band provider error.
              }
              await finish();
              try { controller.close(); } catch { /* consumer cancelled */ }
            },
            cancel() {
              abort.abort();
              void finish();
            },
          });
          return new Response(stream, {
            headers: {
              "cache-control": "no-cache, no-transform",
              "content-type": "text/event-stream; charset=utf-8",
              "x-accel-buffering": "no",
            },
          });
        } catch (error) {
          request.signal.removeEventListener("abort", onAbort);
          return normalizedChatError(error);
        }
      },
    },
    [p("/api/chat/conversations/:conversationId/prompts")]: {
      POST: async (request: RouteRequest) => chatMutation(request, ["requestId", "text", "model", "mode", "variant", "attachments"], async (id, body) => {
        const requestId = bodyIdentity(body, "requestId");
        if (requestId instanceof Response) return requestId;
        if (typeof body.text !== "string") return chatError(400, "text must be a string");
        if (Buffer.byteLength(body.text) > CHAT_PROMPT_BYTES) return chatError(413, "text is too large");
        const model = parseModelSelection(body.model);
        if (model instanceof Response) return model;
        const mode = parseNameSelection(body.mode, "mode");
        if (mode instanceof Response) return mode;
        const variant = parseNameSelection(body.variant, "variant");
        if (variant instanceof Response) return variant;
        // A variant names an effort OF a model, so the pair travels together.
        // Validating a bare variant against server-side memory of "the
        // current model" reads well until that memory is gone — an adapter
        // restart empties it while the session keeps its model — and then
        // the same request flips from accepted to rejected. Requiring the
        // pair makes the contract independent of server lifetime.
        if (variant !== undefined && model === undefined) return chatError(400, "variant requires a model selection");
        const attachments = parsePromptAttachments(body.attachments);
        if (attachments instanceof Response) return attachments;
        // Words or images: a message needs content, and an image-only prompt
        // is content (OpenCode admits empty text with files — verified live).
        if (!body.text.trim() && !attachments?.length) return chatError(400, "text must not be empty");
        return run(() => deps.chatService.prompt(id, requestId, body.text as string, model, mode, variant, attachments), 202);
      }),
    },
    // Multipart rather than JSON: image bytes ride the request as a file
    // field, so nothing base64-inflates and the JSON prompt payload stays
    // reference-only (spec: attachment bytes stay out of the conversation
    // transport). One image per request keeps refusals attributable.
    [p("/api/chat/conversations/:conversationId/attachments")]: {
      POST: async (request: RouteRequest) => {
        const rejected = mutationGate(request);
        if (rejected) return rejected;
        const id = routeIdentity(request, "conversationId");
        if (id instanceof Response) return id;
        if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
          return chatError(415, "content-type must be multipart/form-data");
        }
        // Declared-length gate refuses an honestly oversized body before any
        // read; the streaming gate below is the enforcement that does not
        // trust the client — a chunked upload without Content-Length must
        // not buffer past the cap either. The store re-checks the decoded
        // bytes authoritatively.
        const bodyLimit = CHAT_ATTACHMENT_MAX_BYTES + CHAT_ATTACHMENT_FORM_OVERHEAD_BYTES;
        const declared = Number(request.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > bodyLimit) {
          return chatError(413, "attachment is too large");
        }
        const reader = request.body?.getReader();
        if (!reader) return chatError(400, "missing request body");
        const chunks: Uint8Array[] = [];
        let received = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > bodyLimit) {
              await reader.cancel().catch(() => undefined);
              return chatError(413, "attachment is too large");
            }
            chunks.push(value);
          }
        } catch {
          return chatError(400, "malformed request body");
        }
        const body = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        let form: FormData;
        try {
          form = await new Response(body, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
        } catch {
          return chatError(400, "malformed multipart form data");
        }
        const file = form.get("file");
        if (!(file instanceof Blob)) return chatError(400, 'multipart field "file" must be a file');
        const bytes = new Uint8Array(await file.arrayBuffer());
        return run(() => deps.chatService.saveAttachment(bytes), 201);
      },
    },
    // Not conversation-scoped: the id is a workspace-issued uuid and the
    // authorization boundary is the workspace, same as every chat route.
    [p("/api/chat/attachments/:attachmentId")]: {
      GET: async (request: RouteRequest) => {
        const rejected = authenticated(request);
        if (rejected) return rejected;
        const id = routeIdentity(request, "attachmentId");
        if (id instanceof Response) return id;
        try {
          const stored = await deps.chatService.resolveAttachment(id);
          if (stored === null) return chatError(404, "attachment not found");
          return new Response(Bun.file(stored.absolutePath), {
            headers: {
              "content-type": stored.mimeType,
              // Stored bytes never change under an id, so clients may cache
              // hard — but privately, behind the auth that fetched them.
              "cache-control": "private, max-age=31536000, immutable",
              "x-content-type-options": "nosniff",
            },
          });
        } catch (error) {
          return normalizedChatError(error);
        }
      },
    },
    [p("/api/chat/conversations/:conversationId/cancel")]: {
      POST: async (request: RouteRequest) => chatMutation(request, ["requestId"], async (id, body) => {
        const requestId = bodyIdentity(body, "requestId");
        return requestId instanceof Response ? requestId : run(() => deps.chatService.cancel(id, requestId));
      }),
    },
    [p("/api/chat/conversations/:conversationId/undo")]: {
      POST: async (request: RouteRequest) => chatMutation(request, ["requestId"], async (id, body) => {
        const requestId = bodyIdentity(body, "requestId");
        return requestId instanceof Response ? requestId : run(() => deps.chatService.undo(id, requestId));
      }),
    },
    [p("/api/chat/conversations/:conversationId/redo")]: {
      POST: async (request: RouteRequest) => chatMutation(request, ["requestId"], async (id, body) => {
        const requestId = bodyIdentity(body, "requestId");
        return requestId instanceof Response ? requestId : run(() => deps.chatService.redo(id, requestId));
      }),
    },
    [p("/api/chat/conversations/:conversationId/revert")]: {
      POST: async (request: RouteRequest) => chatMutation(request, ["requestId", "messageId"], async (id, body) => {
        const requestId = bodyIdentity(body, "requestId");
        const messageId = bodyIdentity(body, "messageId");
        if (requestId instanceof Response) return requestId;
        return messageId instanceof Response ? messageId : run(() => deps.chatService.revert(id, messageId, requestId));
      }),
    },
    [p("/api/chat/conversations/:conversationId/restore")]: {
      POST: async (request: RouteRequest) => chatMutation(request, ["requestId", "messageId"], async (id, body) => {
        const requestId = bodyIdentity(body, "requestId");
        const messageId = bodyIdentity(body, "messageId");
        if (requestId instanceof Response) return requestId;
        return messageId instanceof Response ? messageId : run(() => deps.chatService.restore(id, messageId, requestId));
      }),
    },
    [p("/api/chat/conversations/:conversationId/queue/:messageId")]: {
      DELETE: async (request: RouteRequest) => chatMutation(request, ["requestId"], async (id, body) => {
        const messageId = routeIdentity(request, "messageId");
        if (messageId instanceof Response) return messageId;
        const requestId = bodyIdentity(body, "requestId");
        return requestId instanceof Response ? requestId : run(() => deps.chatService.removeQueued(id, messageId, requestId));
      }),
    },
    [p("/api/chat/conversations/:conversationId/permissions/:interactionId")]: {
      POST: async (request: RouteRequest) => chatMutation(request, ["requestId", "outcome", "choiceId"], async (id, body) => {
        const interactionId = routeIdentity(request, "interactionId");
        const requestId = bodyIdentity(body, "requestId");
        if (interactionId instanceof Response) return interactionId;
        if (requestId instanceof Response) return requestId;
        const outcomes = new Set<PermissionOutcome>(["approved-once", "approved-session", "rejected"]);
        if (typeof body.outcome !== "string" || !outcomes.has(body.outcome as PermissionOutcome)) return chatError(400, "invalid permission outcome");
        if (body.choiceId !== undefined && (typeof body.choiceId !== "string" || !body.choiceId || Buffer.byteLength(body.choiceId) > 128)) return chatError(400, "invalid permission choice");
        return run(() => deps.chatService.respondPermission(id, interactionId, requestId, body.outcome as PermissionOutcome, body.choiceId as string | undefined));
      }),
    },
    [p("/api/chat/conversations/:conversationId/tasks/:taskId/stop")]: {
      POST: async (request: RouteRequest) => chatMutation(request, ["requestId"], async (id, body) => {
        const taskId = routeIdentity(request, "taskId");
        const requestId = bodyIdentity(body, "requestId");
        if (taskId instanceof Response) return taskId;
        if (requestId instanceof Response) return requestId;
        return run(() => deps.chatService.stopTask(id, taskId, requestId));
      }),
    },
    [p("/api/chat/conversations/:conversationId/questions/:interactionId")]: {
      POST: async (request: RouteRequest) => chatMutation(request, ["requestId", "outcome"], async (id, body) => {
        const interactionId = routeIdentity(request, "interactionId");
        const requestId = bodyIdentity(body, "requestId");
        if (interactionId instanceof Response) return interactionId;
        if (requestId instanceof Response) return requestId;
        const outcome = parseQuestionMutationOutcome(body.outcome);
        if (outcome instanceof Response) return outcome;
        return run(() => deps.chatService.respondQuestion(id, interactionId, requestId, outcome));
      }),
    },
  };

  async function chatMutation(
    request: RouteRequest,
    keys: string[],
    operation: (id: string, body: Record<string, unknown>) => Promise<Response>,
  ): Promise<Response> {
    const rejected = mutationGate(request);
    if (rejected) return rejected;
    const id = routeIdentity(request, "conversationId");
    if (id instanceof Response) return id;
    const body = await parseJsonObject(request, keys);
    return body instanceof Response ? body : operation(id, body);
  }
}

async function parseJsonObject(request: Request, allowedKeys: string[]): Promise<Record<string, unknown> | Response> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return chatError(415, "content-type must be application/json");
  }
  let text: string;
  try { text = await request.text(); } catch { return chatError(400, "invalid request body"); }
  if (Buffer.byteLength(text) > CHAT_BODY_BYTES) return chatError(413, "request body is too large");
  let value: unknown;
  try { value = text ? JSON.parse(text) : {}; } catch { return chatError(400, "invalid JSON body"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return chatError(400, "request body must be an object");
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).find(key => !allowedKeys.includes(key));
  if (unknown) return chatError(400, `unknown request field: ${unknown}`);
  return body;
}

function routeIdentity(request: RouteRequest, name: string): string | Response {
  let value = request.params?.[name] ?? "";
  try { value = decodeURIComponent(value); } catch { return chatError(400, `invalid ${name}`); }
  return validIdentity(value) ? value : chatError(400, `invalid ${name}`);
}

function bodyIdentity(body: Record<string, unknown>, name: string): string | Response {
  return typeof body[name] === "string" && validIdentity(body[name])
    ? body[name]
    : chatError(400, `invalid ${name}`);
}

function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= CHAT_ID_LIMIT && !/[\u0000-\u001f\u007f]/.test(value);
}

function optionalBounded(value: string | null, name: string, limit: number): string | undefined | Response {
  if (value === null) return undefined;
  return value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : chatError(400, `invalid ${name}`);
}

function parseQuestionMutationOutcome(value: unknown): QuestionOutcome | Response {
  if (!value || typeof value !== "object" || Array.isArray(value)) return chatError(400, "invalid question outcome");
  const outcome = value as Record<string, unknown>;
  if (outcome.kind === "rejected" && Object.keys(outcome).length === 1) return { kind: "rejected" };
  if (outcome.kind !== "answered" || Object.keys(outcome).some(key => key !== "kind" && key !== "answers")) {
    return chatError(400, "invalid question outcome");
  }
  if (!Array.isArray(outcome.answers) || outcome.answers.length > 32) return chatError(400, "invalid question answers");
  let bytes = 0;
  for (const answers of outcome.answers) {
    // Empty is legitimate for a question marked optional; the adapter checks
    // that against the question itself.
    if (!Array.isArray(answers) || answers.length > 32) return chatError(400, "invalid question answers");
    for (const answer of answers) {
      if (typeof answer !== "string" || !answer.trim() || answer.length > 4_096) return chatError(400, "invalid question answer");
      bytes += Buffer.byteLength(answer);
    }
  }
  if (bytes > CHAT_PROMPT_BYTES) return chatError(413, "question answers are too large");
  return { kind: "answered", answers: outcome.answers as string[][] };
}

function parseModelSelection(value: unknown): ModelSelection | undefined | Response {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return chatError(400, "invalid model selection");
  const selection = value as Record<string, unknown>;
  if (Object.keys(selection).length !== 2 || !("providerId" in selection) || !("modelId" in selection)) {
    return chatError(400, "invalid model selection");
  }
  const providerId = typeof selection.providerId === "string" ? selection.providerId : "";
  const modelId = typeof selection.modelId === "string" ? selection.modelId : "";
  return validIdentity(providerId) && validIdentity(modelId)
    ? { providerId, modelId }
    : chatError(400, "invalid model selection");
}

// One rule for both named selections, but each rejection names its own field —
// a client sent "invalid mode selection" for a malformed variant would debug
// the wrong key.
// Strict per-entry validation: references only (never bytes), a bounded
// display name, and one of the four supported image types. Unknown keys on
// an entry are rejected like unknown top-level keys.
function parsePromptAttachments(value: unknown): MessageAttachment[] | undefined | Response {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return chatError(400, "attachments must be an array");
  if (value.length > CHAT_ATTACHMENTS_PER_MESSAGE) {
    return chatError(400, `attachments are limited to ${CHAT_ATTACHMENTS_PER_MESSAGE} per message`);
  }
  const attachments: MessageAttachment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return chatError(400, "invalid attachment");
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length > 3 || keys.some(key => key !== "id" && key !== "name" && key !== "mimeType")) {
      return chatError(400, "invalid attachment");
    }
    if (typeof record.id !== "string" || !validIdentity(record.id)) return chatError(400, "invalid attachment id");
    if (typeof record.name !== "string" || record.name.trim() === "" || Buffer.byteLength(record.name) > CHAT_ATTACHMENT_NAME_BYTES) {
      return chatError(400, "invalid attachment name");
    }
    if (typeof record.mimeType !== "string" || !(CHAT_ATTACHMENT_MIME_TYPES as readonly string[]).includes(record.mimeType)) {
      return chatError(400, "invalid attachment type");
    }
    attachments.push({ id: record.id, name: record.name, mimeType: record.mimeType });
  }
  return attachments.length > 0 ? attachments : undefined;
}

function parseNameSelection(value: unknown, noun: "mode" | "variant"): string | undefined | Response {
  if (value === undefined) return undefined;
  return typeof value === "string" && validIdentity(value)
    ? value
    : chatError(400, `invalid ${noun} selection`);
}

function normalizedChatError(error: unknown): Response {
  if (error instanceof ConversationNotFoundError) return chatError(404, "conversation not found");
  if (error instanceof UnknownAgentError) return chatError(404, error.message);
  if (error instanceof QueuedMessageNotHeldError) return chatError(409, error.message);
  if (error instanceof ChatQueueFullError) return chatError(429, error.message);
  if (error instanceof InteractionConflictError) return chatError(409, error.message);
  if (error instanceof ConversationRenameUnsupportedError) return chatError(409, error.message);
  if (error instanceof ReversibleHistoryUnsupportedError) return chatError(409, error.message);
  if (error instanceof ReversibleHistoryTargetError) return chatError(409, error.message);
  if (error instanceof InvalidQuestionAnswerError) return chatError(400, error.message);
  if (error instanceof BackgroundTaskUnavailableError) return chatError(409, error.message);
  if (error instanceof InvalidConversationTitleError) return chatError(400, error.message);
  if (error instanceof InvalidModelSelectionError) return chatError(400, error.message);
  if (error instanceof InvalidModeSelectionError) return chatError(400, error.message);
  if (error instanceof InvalidPermissionChoiceError) return chatError(400, error.message);
  if (error instanceof InvalidVariantSelectionError) return chatError(400, error.message);
  if (error instanceof ChatUnavailableError) return chatError(503, "chat is unavailable");
  if (error instanceof AttachmentStoreError) {
    return chatError(error.reason === "too-large" ? 413 : 415, error.message);
  }
  if (error instanceof UnknownAttachmentError) return chatError(400, error.message);
  if (error instanceof CommandAttachmentsError) return chatError(400, error.message);
  if (error instanceof Error && /invalid history cursor/.test(error.message)) return chatError(400, "invalid cursor");
  return chatError(500, "chat operation failed");
}

function nextChatEvent<T>(
  pending: Promise<IteratorResult<T>>,
  milliseconds: number,
): Promise<IteratorResult<T> | "keepalive"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve("keepalive"), milliseconds);
    void pending.then(value => {
      clearTimeout(timer);
      resolve(value);
    }, error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function chatError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

function buildProdRoutes(deps: ProdRouteDeps, p: (path: string) => string) {
  const { debug, getMetricsSnapshot } = deps;
  return {
    [p("/debug/metrics")]: {
      GET: () => {
        if (!debug) {
          return new Response("Not found", { status: 404 });
        }
        return Response.json(getMetricsSnapshot());
      },
    },
  };
}

function buildE2ERoutes(deps: E2ERouteDeps, p: (path: string) => string) {
  const { getSession, handleE2EReset, handleE2EPersonalState, handleE2EChat } = deps;
  return {
    [p("/__e2e/terminal-token")]: {
      // Tests don't see the URL token (the e2e server doesn't print it to
      // stdout the way cli.ts does), so this exposes it directly. Localhost-
      // only by Bun.serve's hostname binding; not a real auth bypass — only
      // present in the e2e build.
      GET: () => {
        const session = getSession();
        return Response.json({
          token: session.getTerminalToken(),
          enabled: session.isTerminalEnabled(),
        });
      },
    },
    [p("/__e2e/reset")]: {
      POST: (request: Request) => handleE2EReset(request),
    },
    [p("/__e2e/chat")]: {
      POST: (request: Request) => handleE2EChat(request),
    },
    [p("/api/personal-state")]: {
      GET: (request: Request) => handleE2EPersonalState(request),
      PATCH: (request: Request) => handleE2EPersonalState(request),
    },
  };
}

// ---------------------------------------------------------------------------
// Catch-all fetch fallback — the request paths Bun's static route table can't
// express: the WebSocket upgrade (needs the live server handle), /api/auth
// (sets a cookie from the session's rotating token), and the terminal
// sessions inventory. Previously duplicated near-verbatim between cli.ts and
// tests/e2e/server.ts; this builder is the single source of truth.

type TerminalServerInstance = ReturnType<typeof createTerminalServer>;

// Structural subset of Bun.Server the fallback needs: just `upgrade` for
// the WebSocket handshake. The Origin allowlist deliberately does NOT see
// the server handle — it compares against the request's Host header, so it
// keeps working when the browser reaches uatu through a mapped port.
export type FetchFallbackServer = {
  upgrade(request: Request, options?: { data?: unknown }): boolean;
};

export type FetchFallbackDeps = {
  // Nullable: the PTY backend may be unavailable (old Bun, Windows).
  getTerminalServer: () => TerminalServerInstance | null;
  getTerminalToken: () => string;
  navigationFetch: (request: Request) => Promise<Response>;
  // Normalized base-path prefix. Requests outside it are 404'd here — a
  // prefixed server does not answer at its internal root-relative paths —
  // and handlers below see the stripped, root-relative pathname.
  basePath?: string;
};

export function buildFetchFallback(deps: FetchFallbackDeps) {
  const handleTerminalUpgrade = (
    request: Request,
    requestUrl: URL,
    srv: FetchFallbackServer,
  ): Response | undefined => {
    const terminalServer = deps.getTerminalServer();
    if (!terminalServer) {
      return new Response("terminal disabled", { status: 503 });
    }
    // Accept either the URL token (first-visit path) or the Host-port-scoped
    // auth cookie (PWA / subsequent visits). PWA installs share cookies with
    // the browser session that minted them, so a user who visited /?t=<token>
    // once before installing keeps working — no re-auth needed.
    if (!hasValidTerminalCredentials(request, requestUrl, deps.getTerminalToken())) {
      return new Response("unauthorized", { status: 401 });
    }
    const origin = request.headers.get("Origin");
    if (!isAllowedOrigin(origin, requestUrl)) {
      return new Response("forbidden origin", { status: 403 });
    }
    const sessionId = requestUrl.searchParams.get("sessionId") ?? "";
    const takeover = requestUrl.searchParams.get("takeover") === "1";
    const result = terminalServer.prepareSession(sessionId, { takeover });
    if (result.kind === "invalid") {
      return new Response("invalid or missing sessionId", { status: 400 });
    }
    if (result.kind === "unknown") {
      return new Response("unknown sessionId", { status: 404 });
    }
    if (result.kind === "collision") {
      return new Response("sessionId in use", { status: 409 });
    }
    const upgraded = srv.upgrade(request, { data: { sessionId, takeover } });
    if (!upgraded) {
      return new Response("upgrade failed", { status: 500 });
    }
    // Bun docs: when `upgrade()` succeeds, return `undefined` so the runtime
    // doesn't race a stub response against the WebSocket handshake.
    return undefined;
  };

  // POST /api/auth { token } — validate the token and set a same-origin
  // HttpOnly cookie. The cookie is what makes the PWA install path work:
  // `start_url` is "/" with no query, so without persisted credentials a
  // freshly-launched PWA window has nothing to authenticate with. The
  // cookie is HttpOnly (no JS access — token can't be exfiltrated by an
  // XSS in any sibling document) and SameSite=Strict (no cross-site
  // request can carry it).
  const handleAuth = async (request: Request, requestUrl: URL): Promise<Response> => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }
    const provided = (body as { token?: unknown } | null)?.token;
    if (typeof provided !== "string" || provided.length === 0) {
      return Response.json({ error: "missing token" }, { status: 400 });
    }
    if (!constantTimeEqual(provided, deps.getTerminalToken())) {
      return Response.json({ error: "invalid token" }, { status: 401 });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        // Named for the request's Host port so instances on different host
        // ports keep independent credentials (see terminalCookieName), and
        // Path-scoped to the base path so sessions sharing an origin behind
        // the hub keep independent credentials too.
        "set-cookie": formatTerminalCookie(provided, requestUrl, basePath),
      },
    });
  };

  const basePath = deps.basePath ?? "/";

  return (request: Request, srv: FetchFallbackServer): Response | Promise<Response> | undefined => {
    const requestUrl = new URL(request.url);
    // Handlers below match on root-relative paths, so strip the base-path
    // prefix once here. Outside the prefix there is nothing to serve: the
    // static route table is prefixed too, so an unprefixed /api/* request
    // lands here and must 404 rather than leak the internal route surface.
    const stripped = stripBasePath(requestUrl.pathname, basePath);
    if (stripped === null) {
      return new Response("Not Found", { status: 404 });
    }
    if (stripped !== requestUrl.pathname) {
      requestUrl.pathname = stripped;
    }
    if (requestUrl.pathname === "/api/terminal") {
      return handleTerminalUpgrade(request, requestUrl, srv);
    }
    if (requestUrl.pathname === "/api/auth" && request.method === "POST") {
      return handleAuth(request, requestUrl);
    }
    if (requestUrl.pathname === "/api/auth" && request.method === "GET") {
      return authProbeResponse(request, requestUrl, deps.getTerminalToken());
    }
    const sessionsResponse = handleTerminalSessionsRoute(
      request,
      requestUrl,
      deps.getTerminalServer(),
      deps.getTerminalToken,
    );
    if (sessionsResponse) {
      return sessionsResponse;
    }
    return deps.navigationFetch(request);
  };
}
