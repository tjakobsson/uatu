## 1. Contract Inventory And Tooling

- [x] 1.1 Inventory every Hub, proxied workspace, SSE, NDJSON, terminal REST, and terminal WebSocket operation, recording methods, path templates, authentication, media types, status codes, and current payload types.
- [x] 1.2 Classify each discovered route as public or explicitly excluded, and add a machine-readable public operation inventory plus exclusion manifest that can be checked against server routing.
- [x] 1.3 Select and add isolated development dependencies and scripts for OpenAPI 3.1 validation, streaming-contract validation, compatibility diffing, static documentation generation, and contract-test schema validation.
- [x] 1.4 Add the top-level `api/` source structure, contract metadata schema, initial Hub/workspace revision pair, changelog format, and fixture/example conventions.

## 2. Canonical HTTP Contract

- [x] 2.1 Author shared OpenAPI components for bearer and cookie authentication, common errors, compatibility metadata, workspace identifiers, document and repository models, terminal sessions, personal state, and clone jobs.
- [x] 2.2 Document JSON native login, logout, Hub state, browse, workspace registration/lifecycle/forget, device-session listing/revocation, clone-job creation/input/cancel, and their documented error responses with stable operation IDs.
- [x] 2.3 Document proxied workspace state, document render/diff, search, personal-state, terminal authentication, terminal-session inventory/lifecycle, and relevant request-context parameters under `/s/{workspaceId}/`.
- [x] 2.4 Validate all OpenAPI examples against their schemas and verify the complete OpenAPI operation set matches the public route inventory with no unclassified route families.

## 3. Streaming Protocol Contract

- [x] 3.1 Define machine-readable workspace-state SSE and clone-job SSE channels, including event names, replay identifiers, payload unions, reconnection behavior, terminal events, and errors.
- [x] 3.2 Define the NDJSON search stream item union, completion/error semantics, media type, and cancellation behavior.
- [x] 3.3 Define the terminal WebSocket handshake, binary PTY frames, JSON control frames, attach/resize/exit lifecycle, takeover behavior, and application close codes.
- [x] 3.4 Add protocol examples and validation tests that reject undocumented stream event variants, JSON control frames, and close codes while accepting binary terminal data.

## 4. Runtime Compatibility Identity

- [x] 4.1 Separate the existing bundled-web freshness revision from new public Hub and workspace API revision constants without changing current stale-web-client behavior.
- [x] 4.2 Add Hub and workspace API revision fields to authenticated Hub state and workspace state payloads, using shared machine-readable types that match contract metadata.
- [x] 4.3 Update unit, integration, freshness, and Hub tests to prove product/build changes are independent from public API compatibility and both public revisions are observable through the documented responses.
- [x] 4.4 Add a consistency test that fails when runtime revision constants, source contract metadata, and published OpenAPI examples disagree.

## 5. Executable Synchronization Gates

- [x] 5.1 Add structural contract checks for syntax, references, unique operation IDs, schemas, examples, metadata, changelog structure, and explicit route exclusions.
- [x] 5.2 Add route-coverage tests for the workspace route table/fallback and Hub route families, requiring every public method/path pair to map to one OpenAPI operation and every omitted route to map to an explicit exclusion.
- [x] 5.3 Extend deterministic full-stack Hub/workspace fixtures to validate representative successful and error responses, headers, and status codes for every public operation family against OpenAPI.
- [x] 5.4 Validate SSE events, NDJSON items, and WebSocket control/lifecycle behavior from running integration fixtures against the streaming contract.
- [x] 5.5 Add base-branch compatibility diffing that identifies which API domain changed and fails backward-incompatible changes unless that domain's revision increments and the API changelog includes migration guidance.
- [x] 5.6 Wire fast structural checks into normal CI and retain full black-box contract validation in the integration suite, with clear failure output naming the operation and contract mismatch.

## 6. Human And Agent Documentation

- [x] 6.1 Create concise source guides for authentication, Hub versus workspace boundaries, workspace lifecycle, clone jobs, streaming protocols, errors, and compatibility/revision handling without duplicating schema tables by hand.
- [x] 6.2 Create `api/agent.md` as the compact integration entry point, including authoritative artifact precedence, revision comparison procedure, migration workflow, and direct raw artifact links.
- [x] 6.3 Create `llms.txt` as a static discovery index to the current metadata, agent guide, OpenAPI contract, streaming contract, and changelog.
- [x] 6.4 Add generation verification showing that the OpenAPI contract is consumable by Swift OpenAPI Generator, while keeping generated Apple client code outside this repository.

## 7. Static Product And Documentation Site

- [x] 7.1 Add an isolated Astro static site with UatuCode's visual language, a product homepage, guide navigation, and a generated searchable API reference sourced from `api/openapi.yaml`.
- [x] 7.2 Configure every route, asset, canonical internal link, and raw artifact link for GitHub Pages' `/uatu/` base path, and add a local production-build link checker.
- [x] 7.3 Build `/api/edge/` from the current validated source commit with metadata, hashes, OpenAPI, streaming contract, agent guide, and changelog directly fetchable without JavaScript.
- [x] 7.4 Add static-site tests for essential content, raw artifact media/readability, no broken root-relative links, and agreement between rendered API reference operations and canonical OpenAPI operation IDs.

## 8. GitHub Pages And Release Publication

- [x] 8.1 Add a least-privilege GitHub Pages workflow that consumes the exact validated site artifact for `main` and publishes `edge` without changing `latest`.
- [x] 8.2 Add release-bundle creation containing contract metadata, artifact hashes, and all raw contract/guide files for the tagged source commit.
- [x] 8.3 Add publication logic that preserves existing immutable revision directories, creates a new revision snapshot from the validated release bundle, and atomically advances `latest` to that bundle.
- [x] 8.4 Add workflow tests or dry-run assertions proving ordinary main deployment cannot modify `latest`, prior revision artifacts remain byte-stable, and deployed metadata names the validated commit.
- [x] 8.5 Document repository Pages settings, the public `https://tjakobsson.github.io/uatu/` URLs, first-release initialization, rollback by redeploying a known-good artifact, and recovery of revision history from release bundles.

## 9. End-To-End Verification

- [x] 9.1 Run type checking, the complete unit and integration suites, contract validation, compatibility checks, static-site build, link/base-path checks, and the existing license audit.
- [x] 9.2 Exercise an unauthenticated static fetch of `llms.txt`, agent guide, contract metadata, OpenAPI, streaming contract, and changelog from a local Pages-equivalent build.
- [x] 9.3 Simulate an additive contract change and a breaking Hub or workspace contract change to verify revision and migration gates distinguish them correctly.
- [x] 9.4 Perform a Pages deployment dry run that publishes `edge`, initializes an immutable revision bundle, advances `latest` only through the release path, and preserves the previous revision.
