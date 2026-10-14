## Why

`/api/document` answers every read failure except "not found" and "binary" with a 500, and the preview treats a 5xx as transient and retries four times (250 ms, 1 s, 3 s, 10 s). A document that can never be read — permission denied (`EACCES`/`EPERM`), a path that is now a directory (`EISDIR`) — is therefore re-read five times by every open client, writes five `console.error` lines to the session log per view, and shows "Retrying…" for about 14 s before settling on "Select it again to retry", which restarts the same cycle. The client also retries a `200` whose body is not valid JSON, although retrying will not make that answer parse. Both behaviors come from the 404/415/500 split and the retry schedule that #462 added. That work has not yet shipped in a stable release, so this change corrects it before it does (tjakobsson/uatu#469).

## What Changes

- The server answers a filesystem condition that will not change on its own as a final 4xx, not a 500:
  - `EACCES` and `EPERM` become **403** with body `{ "error": "document not readable" }`.
  - `EISDIR`, `ELOOP` and `ENAMETOOLONG` become **404** (`{ "error": "document not found" }`), joining `ENOENT` and `ENOTDIR`: the indexed path no longer resolves to a readable file.
  - The server logs none of these, as it already does not log a 404.
- Renderer throws and transient resource failures (`EMFILE`, `ENFILE`, `EAGAIN`, `EBUSY`, `EIO`, and any unrecognized error) stay **500**, are logged, and are retried. A broken renderer stays visible.
- The preview's final notice depends on the status, so it explains the failure instead of saying "Retrying…". A 403 says the file cannot be read because of its permissions. A 404 keeps today's "may have been removed or excluded" text. Any other final failure gets a generic notice that tells the user to select the file again.
- Only a request that gets no answer (a `fetch()` that throws, or the body of a successful answer breaking before it finishes) counts as transient alongside 5xx, 408 (Request Timeout) and 429 (Too Many Requests). Every other 4xx is final, even when its body breaks mid-read, and so is a `200` whose body fails to parse as JSON.
- The `document not readable` tag that the server sends and the preview compares is declared once in `src/shared/`, so rewording it cannot silently drop the permission notice.
- The retry schedule (`[250, 1000, 3000, 10000]` ms, a key per selection and activation) stays as it is. The design records why.
- `ARCHITECTURE.md`'s failure-path list is updated to match.

Out of scope: honoring a `Retry-After` header on a 408 or 429, keeping the last good render visible while the same document retries (tjakobsson/uatu#468), the `/api/document/diff` endpoint's error mapping, and how the preview handles a hub 401.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `document-watch-index`: Adds a requirement for how the preview classifies a failed document load as final or transient, what the server answers for each class, and what the preview tells the user.

## Impact

- Server: `src/server/render-dispatch.ts` (`documentErrorStatus`) and `src/server/routes.ts` (the `/api/document` handler's 403 branch and its logging).
- Client: `src/preview/load-retry.ts` (classification) and `src/preview/mount.ts` (fetch, body read and parse are classified separately; the final notice depends on the status).
- Shared: `src/shared/document-errors.ts` (the `document not readable` tag, imported by server and client).
- Tests: `src/server/render-dispatch.test.ts`, `src/server/routes.test.ts`, `src/preview/load-retry.test.ts`, and a new e2e case in `tests/e2e/view-and-layout.e2e.ts`.
- Docs: `ARCHITECTURE.md` (document failure paths).
- `/api/document` belongs to the internal workspace protocol (`api/exclusions.yaml` → `workspace-api`), so the public API contract does not change. The hub proxy passes upstream status codes through unchanged, so a hub-served session needs no proxy change.
