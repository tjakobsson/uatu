## Context

The public HTTP surface is split between the Hub fetch handler (`src/hub/server.ts`), the workspace Bun route table and fallback (`src/server/routes.ts`), and terminal route/protocol modules. Request and response shapes are partly named TypeScript types and partly inline object literals. Full-stack tests exercise much of the surface, but there is no artifact that an external client can consume as the wire contract.

OpenSpec remains the behavioral requirements system; it is not an endpoint schema format or generated-client input. The documentation must therefore add a wire-contract source without duplicating behavioral intent, and CI must bridge that source to the implementation. GitHub Pages will serve under the repository base path `/uatu/`, while raw contract URLs must remain easy for agents and tooling to fetch.

The existing `API_REVISION` is coupled to the bundled workspace web client freshness handshake. Independent clients need separate Hub and workspace wire-contract compatibility identities because those surfaces can evolve independently and product/build changes are not necessarily contract breaks.

## Goals / Non-Goals

**Goals:**
- Establish one reviewed source for exact public HTTP operations and schemas.
- Publish useful static interfaces for product visitors, API developers, generators, and agents.
- Make compatibility comparison deterministic through immutable revisions and migration notes.
- Detect route, schema, and implementation drift before merge or publication.
- Keep the contract portable to a future standalone contract repository without requiring that move now.

**Non-Goals:**
- Generate or implement the separate Apple multiplatform application.
- Move, redesign, or use the provisional macOS desktop application as the contract consumer.
- Replace OpenSpec behavioral requirements with OpenAPI descriptions.
- Declare every existing internal route public; debug, test, asset, and HTML surfaces stay out unless deliberately promoted.
- Make the pre-1.0 API backward compatible. Breaking changes remain allowed when revisioned and documented.
- Generate server routing or handler implementations from OpenAPI in the first iteration.

## Decisions

### 1. Author contracts in a dedicated `api/` source tree

The repository will hold reviewed contract sources under a top-level `api/` tree, separate from the generated site and `openspec/`:

```text
api/
├── openapi.yaml
├── streaming.yaml
├── contract.json
├── CHANGELOG.md
├── agent.md
├── exclusions.yaml
├── guides/
└── examples/
```

`openapi.yaml` is authoritative for HTTP operation and JSON schema details. `streaming.yaml` is a machine-readable protocol description for SSE, NDJSON, and WebSocket behavior; AsyncAPI is preferred where it models the channel, with documented extensions or linked Markdown only where mixed binary/control framing cannot be represented faithfully. `contract.json` is source metadata with revision identities; publication fills build-derived fields such as commit and publication time.

Alternative: derive OpenAPI entirely from TypeScript handlers. Rejected initially because route and payload shapes are not declared uniformly enough, inferred schemas omit descriptions and semantic errors, and making inference reliable would require restructuring the server before documentation can exist.

Alternative: handwrite only Markdown. Rejected because prose cannot reliably drive Swift generation, schema validation, or compatibility diffing.

### 2. Model Hub and workspace surfaces in one document with separate revision metadata

One OpenAPI document will describe the origin clients actually use, including Hub routes and `/s/{workspaceId}/api/...` workspace routes. Tags and operation-id prefixes separate the domains. Contract metadata carries `hubApiRevision` and `workspaceApiRevision` independently.

This lets an Apple client generate one transport package while still deciding whether a Hub-only change affects its workspace integration. The Hub state response reports both revisions because the Hub brokers the child surface and is the external client's compatibility entry point. Direct workspace state reports the workspace public revision as well.

Alternative: publish separate Hub and workspace OpenAPI files. This offers cleaner ownership but complicates cross-domain schemas, agent discovery, generation, and atomic publication. The single document can be split later without changing the metadata/revision model.

### 3. Keep bundled-web freshness separate from public API compatibility

The current `API_REVISION` will be renamed conceptually and in code to a bundled-web contract revision. Public Hub and workspace revisions will be separately named constants used by runtime compatibility payloads and publication metadata.

```text
Product/build identity
├── version + commit
└── answers: "which build is running?"

Bundled web revision
└── answers: "can these shipped web assets speak to this workspace server?"

Public API revisions
├── Hub API revision
├── workspace API revision
└── answer: "can an independently released client use this wire contract?"
```

Revisions are monotonically increasing integers while the API is experimental. Additive compatible changes do not require an increment; backward-incompatible changes increment only the affected domain. Every published snapshot records both values so a pair, rather than either integer alone, identifies the full contract.

Alternative: use the package semantic version. Rejected because product releases can change UI or internals without changing API compatibility, and one release can contain changes to only one API domain.

### 4. Build a fully static Pages site with direct raw artifacts

A static-site generator will produce the product homepage, guides, and API reference. Astro is the preferred fit because it supports a custom product surface, Markdown content, static output, and base-path configuration without requiring a client-side documentation application. The reference may embed a static-capable OpenAPI renderer, but raw files remain primary agent/tool interfaces.

The build output includes:

```text
/
├── index.html
├── docs/
├── llms.txt
└── api/
    ├── edge/
    ├── latest/
    └── revisions/<pair-or-release-id>/
```

The public URL is GitHub's repository Pages URL; all generated navigation and assets respect `/uatu/`. `llms.txt` is a compact discovery index. `agent.md` explains which artifacts are authoritative and how to compare compatibility, but does not duplicate all endpoint schemas.

Alternative: host only an OpenAPI renderer. Rejected because UatuCode also needs a homepage and conceptual guides, and agents need raw non-JavaScript resources.

### 5. Preserve immutable revisions in source-controlled publication history

The Pages deployment must not reconstruct old revisions from whatever happens to be in `main`. Release publication will create a versioned contract bundle as a release artifact and retain immutable snapshots in a dedicated Pages history location or deployment branch. The chosen mechanism must preserve prior revision directories when deploying new site output.

`edge` is regenerated from `main`. `latest` is copied from the most recent released bundle, not from `edge`. A release advances `latest` only after the tagged source passes contract validation. Each published metadata file records source commit and artifact hashes, allowing consumers to verify equivalence even though GitHub Pages does not provide immutable caching semantics by itself.

Alternative: commit all generated revision snapshots to `main`. Rejected because generated history would add noisy large diffs to product development. Release assets plus a deployment history keep source and publication responsibilities separate.

### 6. Introduce a public route inventory as the synchronization seam

The first implementation will add a small declarative inventory of public operation IDs, methods, and path templates, plus explicit exclusions. Existing handlers remain in place. Tests compare this inventory with the OpenAPI operations and exercise each operation family against running servers.

For the workspace static route table, inventory can be checked against `buildRoutes()` keys and fallback families. For the Hub's imperative fetch handler, route-family tests and explicit inventory coverage provide the seam until a future change moves Hub dispatch into a declarative route table. Adding a supported endpoint therefore requires changing the inventory and contract in the same pull request.

Alternative: immediately refactor all Hub routing into a schema-carrying framework. Rejected as too much architectural churn for establishing the contract and likely to obscure behavioral regressions.

### 7. Layer validation from cheap structural checks to black-box tests

CI will use four complementary gates:

1. Lint and validate OpenAPI, streaming definitions, metadata, links, examples, and generated site base paths.
2. Compare public route inventory and explicit exclusions against documented operation IDs and path/method pairs.
3. Run full-stack Hub/workspace fixtures and validate representative requests and responses, including errors and streaming event payloads, against the contract.
4. Diff the proposed contract against the appropriate base contract. If backward-incompatible changes are found, require the affected revision increment and a structured changelog entry with migration guidance.

Black-box validation extends the existing integration tests rather than replacing feature assertions. Dynamic data and intentionally open fields must be modeled accurately rather than normalized away. Streaming tests validate event/item schemas and WebSocket control frames; binary PTY payloads are checked as binary protocol frames, not coerced into JSON.

Alternative: rely on generated TypeScript types. Rejected because handlers can return inline or malformed runtime values despite compile-time types, and types do not cover status codes, headers, or route presence.

### 8. Pages deployment consumes an already validated build artifact

The Pages job will not independently rebuild from an unverified checkout after contract checks. CI builds a static artifact containing contract metadata for the exact commit, validates it, and the deploy job consumes that artifact with GitHub's Pages actions and least-privilege permissions. Main updates publish `edge`; tagged releases additionally publish an immutable snapshot and update `latest`.

Pull requests build the site and run link/base-path checks without deploying. GitHub Pages environment protection remains available if repository settings require approval.

## Risks / Trade-offs

- [Risk] A handwritten OpenAPI file can still drift from imperative handlers. -> Mitigation: public route inventory, response validation, representative error tests, and breaking-change diffing are all required; no single check is treated as sufficient.
- [Risk] Full response validation across large state payloads may be brittle and initially expose undocumented optionality. -> Mitigation: model actual variability explicitly, seed deterministic integration fixtures, and add operation families incrementally while requiring complete coverage before publication is declared authoritative.
- [Risk] OpenAPI and AsyncAPI tooling may not model mixed binary WebSocket frames perfectly. -> Mitigation: keep the HTTP upgrade in OpenAPI, use the strongest machine-readable channel format available, and supplement only irreducible frame semantics with versioned protocol Markdown and executable tests.
- [Risk] `latest` can accidentally track unreleased `main`. -> Mitigation: source `latest` only from a validated tagged release bundle; test metadata stability in ordinary main deployments.
- [Risk] GitHub Pages deployment can overwrite old revisions. -> Mitigation: make history preservation an integration-tested publication step and retain release bundles as a recoverable immutable source.
- [Risk] Contract generation creates false confidence about semantic compatibility. -> Mitigation: migration notes and behavioral OpenSpec requirements remain necessary; the contract explicitly covers wire compatibility, not every product semantic.
- [Trade-off] One combined OpenAPI document is convenient for consumers but couples release publication of two API domains. -> Mitigation: independent revision fields preserve domain-level compatibility and leave a future split possible.
- [Trade-off] The static site adds frontend dependencies to a compact Bun project. -> Mitigation: isolate site dependencies and scripts from product runtime dependencies and keep the emitted site entirely static.

## Migration Plan

1. Inventory existing Hub, workspace, streaming, and terminal surfaces and classify each as public or explicitly excluded.
2. Establish revision 1 contracts from current behavior without claiming compatibility with undocumented historical builds.
3. Add runtime Hub/workspace revision fields additively while retaining the bundled-web freshness behavior under its clarified identity.
4. Add validation and black-box contract tests before declaring the contract authoritative.
5. Publish `edge` to GitHub Pages and verify direct artifact URLs and `/uatu/` base-path behavior.
6. On the next release, publish the first immutable revision bundle and initialize `latest` from it.

Rollback of the Pages site consists of redeploying the last known-good Pages artifact. Runtime revision fields are additive and can remain through a documentation rollback. Previously published revision snapshots must never be deleted as part of rollback.
