## Context

`uatu watch` intentionally exposes a local browser server on `127.0.0.1` so Markdown, AsciiDoc, source files, images, and other adjacent assets can be previewed from watched roots. The current indexed sidebar applies hardcoded ignores, `.uatuignore`, `.gitignore`, and symlink skipping, but the static fallback path only performs lexical root containment before serving an existing filesystem path. That creates a mismatch: files hidden from the UI may still be fetched directly, and symlinks can potentially point outside the watched root.

The rendering pipelines already have strong HTML controls: Markdown and AsciiDoc output is sanitized, Asciidoctor runs in secure mode, and Mermaid runs with strict security. The main runtime hardening work should therefore focus on filesystem serving boundaries and local mutation endpoints rather than replacing the rendering stack.

The repository also uses GitHub Actions for CI and Claude automation. CI currently uses mutable action tags and `bun-version: latest`; Claude workflows grant write permissions and can be triggered by comment text without an explicit trusted-actor gate.

## Goals / Non-Goals

**Goals:**

- Make static fallback authorization consistent with the files the session intentionally exposes.
- Prevent symlink and realpath escapes from watched roots.
- Default-deny common secret-bearing filenames across indexing, rendering, and static fallback.
- Handle malformed URL encoding safely.
- Validate `/api/scope` mutations against the current visible document set.
- Reduce GitHub workflow supply-chain and permission risk while preserving CI and review automation.
- Add regression tests that lock the security boundaries in place.

**Non-Goals:**

- Add network authentication or make `uatu` suitable for binding to non-localhost interfaces.
- Add a user-facing opt-in flag for previewing secret-like files in this change.
- Replace the Markdown, AsciiDoc, syntax highlighting, or Mermaid rendering libraries.
- Solve the transitive `uuid` advisory by forking dependencies unless an upstream-safe update path is available.

## Decisions

1. Centralize file exposure checks in server code.

   Static fallback should use one helper that answers whether a request path maps to an allowed file. The helper should combine URL path decoding, lexical containment, realpath containment, symlink rejection, ignore matching, hardcoded denylist checks, secret-name checks, and file existence/type checks. This avoids duplicating logic between the production CLI and E2E server.

   Alternative considered: only patch the fallback loop in `cli.ts` and `e2e-server.ts`. That is smaller initially but keeps the security policy spread across entrypoints and makes tests harder to target.

2. Enforce containment after resolving real paths.

   A candidate should only be served if both the watched root and candidate resolve to real paths and the candidate remains under the root after symlink resolution. Symlink path components should not provide access to outside-root content. Direct symlink files should be rejected consistently with scanner behavior.

   Alternative considered: only call `lstat` on the final candidate and reject if it is a symlink. That misses symlinked intermediate directories.

3. Treat secret-like filenames as not exposed by default.

   A small denylist/pattern set should cover common local credential files: `.env`, `.env.*`, `.npmrc`, `.pypirc`, private-key extensions/names, and obvious credential filenames. The scanner should skip these by default so they do not appear in the sidebar, and static fallback/rendering should not serve them by direct path.

   Alternative considered: rely on `.gitignore` alone. That is insufficient because users may run with `--no-gitignore`, watch arbitrary folders, or have incomplete ignore files.

4. Keep malformed path handling conservative.

   Malformed percent-encoding should not throw through Bun request handling. Returning `404` is sufficient and avoids revealing parsing details; `400` is also acceptable if tests assert only safe failure.

   Alternative considered: normalize invalid encodings manually. That creates edge cases without adding value for a local static fallback.

5. Validate scope by visible document ID.

   `/api/scope` should only accept `{ kind: "file", documentId }` when the document currently exists in the session roots and is not binary. Rejected mutations should return `400` or `404` and leave current scope unchanged.

   Alternative considered: accept arbitrary IDs and rely on the next refresh to reset invalid state. That leaves a short-lived invalid state and weakens the endpoint contract.

6. Harden workflows with least privilege and reproducibility.

   CI should pin Bun and actions. Claude workflows should require trusted actor/author association before running and should remove permissions that are not required for their action mode. Full SHA pinning is preferred for third-party actions, with update automation left to maintain those pins.

   Alternative considered: leave action tags and rely on Renovate. Tags remain mutable between update PRs, so this does not fully address supply-chain risk.

## Risks / Trade-offs

- Existing documents that link to ignored files will stop loading those references → This is intentional; document the behavior and ensure tests cover both default ignore behavior and `--no-gitignore` where appropriate.
- Secret filename denylist may hide a harmless file someone wanted to preview → Prefer safe defaults; future work can add an explicit opt-in if there is real demand.
- Realpath checks add filesystem I/O to static fallback requests → The server is local and fallback requests are asset-sized; keep implementation simple and add caching only if profiling shows a problem.
- GitHub action SHA pinning increases update maintenance → Use existing update automation to keep pinned actions current.
- Actor gating for Claude may block useful outside contributions → Allow collaborators/owners/members first; broader interaction can be revisited with a safer read-only workflow.
