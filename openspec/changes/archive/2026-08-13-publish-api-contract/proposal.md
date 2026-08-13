## Why

UatuCode's HTTP and streaming contracts are currently implicit across route handlers, TypeScript types, tests, and behavioral specifications, so an independently developed Apple client or an AI agent must clone and reverse-engineer this repository to discover compatibility changes. The API is still evolving, making a published, versioned, and mechanically checked contract necessary before separate clients begin depending on it.

## What Changes

- Add a canonical OpenAPI 3.1 description for the public Hub and proxied workspace HTTP APIs, supplemented by machine-readable streaming protocol documentation where OpenAPI cannot express SSE, NDJSON, or WebSocket semantics completely.
- Add concise human and agent guides covering authentication, API boundaries, common workflows, compatibility, and how to consume the contract without cloning the repository.
- Generate a static UatuCode product and documentation site and publish it through GitHub Pages at the repository's standard `https://tjakobsson.github.io/uatu/` URL.
- Publish stable raw artifacts alongside the rendered documentation, including `llms.txt`, an agent guide, contract metadata, OpenAPI, streaming protocol documentation, and an API changelog.
- Distinguish the contract on `main` (`edge`), the latest released contract (`latest`), and immutable numbered API revisions so clients can pin and compare contracts.
- Add CI checks that validate contract files, test representative running-server responses against them, detect breaking contract changes, require revision and migration metadata when appropriate, verify documented route coverage, and gate Pages publication on those checks.
- Expose a public API revision from running Hub and workspace APIs so independently released clients can compare a server with their pinned contract instead of inferring compatibility from the product version.

## Capabilities

### New Capabilities
- `api-contract-publication`: Defines the canonical API contract, human and agent documentation, compatibility revisions, generated GitHub Pages publication, and synchronization enforcement.

### Modified Capabilities

- `hub-service`: Expose Hub API compatibility identity independently from the product build version.
- `client-freshness`: Distinguish externally consumed Hub and workspace API contract revisions from the bundled web-client freshness handshake.

## Impact

- Adds reviewed contract and documentation sources, a static-site build, and a GitHub Pages deployment workflow.
- Adds API schema validation, compatibility diffing, route coverage, and black-box contract checks to CI.
- Requires Hub and workspace state or capability responses to expose explicit contract revision metadata.
- Introduces documentation and validation tooling dependencies and may introduce a Swift OpenAPI generation verification step without adding Apple application code to this repository.
- Does not move or modify the provisional macOS desktop application; the published contract targets independently developed clients.
