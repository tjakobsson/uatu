## Why

`tests/e2e/document-tree.e2e.ts` contains literal NUL bytes in a binary-file fixture, causing Git and text-search tools to classify the TypeScript source as binary. This hides matches, obscures diffs, and makes maintenance less reliable even though the fixture itself only needs to produce those bytes at runtime.

## What Changes

- Represent the fixture's control and NUL characters with TypeScript escape sequences instead of literal bytes in the source file.
- Preserve the fixture's runtime value and the E2E coverage for binary documents.
- Verify that standard file, search, and Git tooling treats the test file as text after the change.

## Capabilities

### New Capabilities

None. This is test-source hygiene and does not introduce product behavior.

### Modified Capabilities

None. Existing document-tree and binary-document requirements remain unchanged, so this change opts out of delta specs.

## Impact

- Affects `tests/e2e/document-tree.e2e.ts` only during implementation.
- Does not change production code, public APIs, dependencies, or user-visible behavior.
- Improves repository searchability and produces readable text diffs for the affected E2E file.
