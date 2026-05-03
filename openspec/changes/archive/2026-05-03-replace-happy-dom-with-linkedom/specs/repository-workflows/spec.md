## ADDED Requirements

### Requirement: Test-only DOM-simulation tooling runs under the pinned Bun runtime

Any third-party library used by the repository's test suite to simulate a browser DOM (creating `Document`/`Window` objects, parsing `innerHTML`, executing `querySelector`/`querySelectorAll`, reading inline styles, etc.) MUST run cleanly under the project's pinned Bun runtime version. A library that depends on Node-specific runtime behavior that Bun does not faithfully reproduce — most notably installing global constructors on a contextified `Window` via `vm.createContext` and `Script.runInContext` — MUST NOT be selected, even if it is otherwise the fastest or most popular option.

This requirement applies to dev-only tooling; it does not constrain runtime dependencies of the shipped `uatu` artifact.

#### Scenario: A new DOM-simulation library is proposed for tests

- **WHEN** a contributor or automated update proposes adding or upgrading a DOM-simulation devDependency
- **THEN** the change MUST be rejected unless the library's test execution succeeds end-to-end under the repository's pinned Bun runtime
- **AND** the rejection rationale MUST cite this requirement so the next reviewer does not reintroduce the same failure mode

#### Scenario: The pinned Bun runtime is upgraded

- **WHEN** the repository's pinned Bun runtime version is upgraded
- **THEN** the existing test-DOM tooling MUST continue to pass the test suite under the new Bun version before the runtime upgrade is merged
