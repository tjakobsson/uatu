## Why

The local preview server currently has a few security boundary gaps around static file serving, scope mutation, and secret-like files that are hidden from the browser tree but may still be reachable over HTTP. The repository automation also grants broad write-capable AI workflow permissions and uses mutable runtime/action versions, which creates avoidable supply-chain and permission risk.

## What Changes

- Harden static fallback serving so it only serves files that remain inside watched roots after realpath/symlink resolution.
- Apply the same ignore and denylist posture to static fallback serving that the indexed browser tree uses, so ignored files are not reachable by direct URL.
- Default-deny common secret-bearing filenames such as `.env`, `.env.*`, `.npmrc`, credential files, and private keys unless an explicit future opt-in is introduced.
- Make malformed URL paths fail safely with a client error or 404 instead of throwing from request handling.
- Validate file-scoped preview requests before accepting `/api/scope` mutations.
- Constrain GitHub AI workflows to trusted actors, reduce workflow permissions where practical, pin toolchain/action versions, and keep update automation compatible with pinned versions.
- Add regression coverage for ignored-file access, symlink escape, malformed URL handling, secret-file exclusion, and scope validation.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `document-watch-browser`: Static serving and preview scope behavior must enforce watched-root, ignore, symlink, malformed-path, and secret-file boundaries.
- `repository-workflows`: GitHub validation and AI automation must run with reproducible versions and least-privilege/trusted-trigger controls.

## Impact

- Affected runtime code: `src/cli.ts`, `src/e2e-server.ts`, `src/server.ts`, `src/file-classify.ts`, and related tests.
- Affected browser behavior: direct links or image references to ignored/secret/symlinked files will stop loading through the local static fallback.
- Affected repository automation: `.github/workflows/*.yml`, `package.json`, lockfile/update configuration if needed.
- No intentional breaking change to documented safe preview workflows; unsafe direct access paths become unavailable by design.
