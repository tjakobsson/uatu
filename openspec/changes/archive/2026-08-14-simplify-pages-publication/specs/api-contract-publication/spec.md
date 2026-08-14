## ADDED Requirements

### Requirement: The published contract has a single identity derived from main
The published API contract SHALL have exactly one identity, built from the current `main` branch, with no release-derived or historical channels. Contract metadata SHALL identify the API revision pair, stability, the source commit it was built from, and the publication time. The site MUST NOT retain published state between deployments: each deployment is the complete build output of one commit, so no publication depends on what a previous publication left behind.

#### Scenario: Main changes
- **WHEN** a contract change merges to the main branch and the site is published
- **THEN** the published contract metadata identifies that source commit
- **AND** the published artifacts are the ones built from that commit

#### Scenario: A product release is published
- **WHEN** a `v*` release is tagged and published
- **THEN** the site's published contract is unchanged by the release itself
- **AND** no release-derived channel or snapshot directory is created

#### Scenario: Publishing twice from one commit
- **WHEN** the publication runs twice for the same source commit
- **THEN** both runs deploy equivalent artifacts
- **AND** neither run depends on state carried over from an earlier publication

## MODIFIED Requirements

### Requirement: GitHub Pages publishes the product site and raw API artifacts
The project SHALL publish a static UatuCode product and documentation site at the repository's standard GitHub Pages URL under `/uatu/`. The site SHALL work with that base path and SHALL expose static, directly fetchable raw artifacts at documented stable paths, including `llms.txt`, the agent guide, OpenAPI contract, streaming protocol contract, contract metadata, and API changelog. Raw contract artifacts SHALL be served directly under `/uatu/api/` with no channel path segment. Essential agent-facing content MUST be available without executing client-side JavaScript or authenticating.

#### Scenario: User opens the repository Pages site
- **WHEN** a user visits `https://tjakobsson.github.io/uatu/`
- **THEN** the product homepage and documentation navigation load with links and assets resolved under the `/uatu/` base path

#### Scenario: Agent fetches a raw artifact
- **WHEN** an agent fetches a documented OpenAPI, metadata, guide, or changelog URL directly
- **THEN** it receives the artifact as static text or structured data without a repository clone, authentication, or browser execution

#### Scenario: Agent fetches the OpenAPI contract by its documented path
- **WHEN** an agent fetches `https://tjakobsson.github.io/uatu/api/openapi.yaml`
- **THEN** it receives the OpenAPI 3.1 contract without a channel segment in the path

#### Scenario: Agent discovers documentation from the site root
- **WHEN** an agent fetches the site's `llms.txt`
- **THEN** it finds direct links to the current contract metadata, agent guide, API contracts, and changelog
- **AND** every link it lists resolves to a published artifact

### Requirement: Contract changes are validated before publication
Continuous integration SHALL validate contract syntax and references, compare supported route inventory with documented operations, validate representative running-server requests and responses against the contract, and report backward-incompatible contract differences against the appropriate baseline. A breaking change MUST increment the affected public API revision and include consumer-facing migration information in the API changelog. The publication workflow MUST itself validate the contract it builds and MUST verify the built site before deploying it, and MUST NOT deploy when either check fails.

#### Scenario: Handler response drifts from its schema
- **WHEN** a contract test observes a documented operation returning a status or body that violates its contract
- **THEN** continuous integration fails before the change can be published

#### Scenario: New supported route is undocumented
- **WHEN** a change adds an externally supported route without a corresponding contract operation
- **THEN** the route coverage check fails unless the route is explicitly classified as non-public

#### Scenario: Breaking change lacks migration metadata
- **WHEN** compatibility comparison detects a backward-incompatible change without the required revision increment and changelog migration entry
- **THEN** continuous integration fails

#### Scenario: Pages reflects validated sources
- **WHEN** the Pages workflow deploys a successful build
- **THEN** its contract metadata identifies the same source commit that passed contract validation

#### Scenario: Publication validates what it deploys
- **WHEN** the publication workflow runs for a commit whose contract fails validation or whose built site fails its link and content checks
- **THEN** the workflow fails without deploying
- **AND** the previously deployed site remains live

## REMOVED Requirements

### Requirement: Published contracts have edge, latest, and immutable revision identities
**Reason**: The three-channel design required two independent writers — every push to `main` and every `v*` tag — to share one atomically-deployed site. That forced a `pages-history` branch as shared mutable state, and with it cross-workflow concurrency locks, byte-hash immutability guards, a staleness guard, an attempt-bounded retry workflow, and two `workflow_run` privilege hops. The channels served no consumer: the site has never deployed, so `/api/latest/` and `/api/revisions/` have never existed.

**Migration**: None required — no published URL is being withdrawn, because none was ever published. Consumers read the single contract at `/uatu/api/`, whose metadata continues to report the API revision pair for compatibility analysis. Clients needing a fixed snapshot pin the repository tag or commit that `contract.json` names in `sourceCommit`. If release-pinned channels are wanted later, they can be derived from published GitHub Releases without reintroducing shared mutable publication state.
