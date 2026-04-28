## 1. Static Fallback Hardening

- [x] 1.1 Add shared server-side helpers for decoding fallback paths safely and returning non-success responses for malformed percent-encoding.
- [x] 1.2 Add shared server-side helpers that resolve candidate files with realpath containment checks against watched roots.
- [x] 1.3 Reject direct symlink files and symlinked path escapes in static fallback serving.
- [x] 1.4 Apply hardcoded ignores, `.uatuignore`, and active `.gitignore` matching to static fallback serving.
- [x] 1.5 Wire the hardened fallback helper into both `src/cli.ts` and `src/e2e-server.ts`.

## 2. Secret And Scope Boundaries

- [x] 2.1 Add default-denied secret filename/path patterns for `.env`, `.env.*`, `.npmrc`, credential files, and private-key files.
- [x] 2.2 Apply secret exclusion consistently in scanning, document rendering, and static fallback serving.
- [x] 2.3 Validate `/api/scope` file mutations against the current visible non-binary document set before mutating session scope.
- [x] 2.4 Ensure rejected scope mutations leave the current scope unchanged and return a non-success response.

## 3. Runtime Regression Tests

- [x] 3.1 Add tests that ignored files are hidden from the tree and cannot be fetched directly through static fallback.
- [x] 3.2 Add tests that symlink escapes outside watched roots are rejected by static fallback.
- [x] 3.3 Add tests that malformed fallback URL encoding fails safely without an uncaught exception.
- [x] 3.4 Add tests that secret-like files are excluded from indexing, rendering, and static fallback serving.
- [x] 3.5 Add tests that invalid, ignored, secret-like, and binary document IDs are rejected by `/api/scope`.

## 4. Repository Workflow Hardening

- [x] 4.1 Pin the Bun runtime version in CI and add matching package manager metadata where appropriate.
- [x] 4.2 Pin GitHub Actions references to immutable or explicitly maintained pinned versions.
- [x] 4.3 Restrict write-capable Claude workflow triggers to trusted actors or trusted author associations.
- [x] 4.4 Reduce workflow permissions to the minimum required for CI, review, and write-capable AI automation.
- [x] 4.5 Ensure update automation can surface dependency, runtime, and action pin updates.

## 5. Validation

- [x] 5.1 Run `bun test` and fix any failures.
- [x] 5.2 Run `bun run check:licenses` and fix any failures.
- [x] 5.3 Run `bun run build` and fix any failures.
- [x] 5.4 Run `bun run test:e2e` or document why it could not be run.
- [x] 5.5 Run OpenSpec validation/status checks for `harden-local-preview-security`.
