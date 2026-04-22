## Context

The repository now contains a working Bun application, a completed archived feature change, an active main spec for the document watch behavior, and both unit and Playwright-based end-to-end tests. What it still lacks is the repository-facing layer that explains how to work on the project and that enforces the same checks on GitHub that contributors are expected to run locally.

This change is cross-cutting because it touches project documentation, GitHub Actions automation, and the contributor workflow around Bun, Playwright, and OpenSpec. It also lays the foundation for later GitHub-native automation such as badges, Scorecards, and additional security checks.

## Goals / Non-Goals

**Goals:**
- Add a root `README.md` that explains what the project is, how to run it, and how to validate changes locally.
- Add GitHub Actions workflows that run the repository's core checks on GitHub.
- Make the CI workflow align with the actual local validation commands already used by the project.
- Support local and CI execution of Playwright E2E tests without exposing test-only tooling to end users.
- Keep repository tooling and GitHub Actions versions current through GitHub-native automation.
- Prepare the repository for badge-style GitHub reporting and later automation work.

**Non-Goals:**
- Add release automation, publishing, or deployment workflows in this change.
- Add OpenSSF Scorecards, CodeQL, or other security workflows yet.
- Change the application's user-facing behavior beyond documentation or test execution.
- Require the compiled `uatu` binary to carry CI or test-only dependencies.

## Decisions

### Use one repository workflow change for README and GitHub Actions
The README and GitHub Actions are part of the same repository-facing concern: making the project understandable and verifiable. Keeping them in one change gives contributors a single source of truth for both the documented commands and the automated checks that enforce them.

Alternatives considered:
- Split README and CI into separate changes: possible, but creates unnecessary overhead for tightly related repo setup.
- Fold this work into the product feature change: rejected because that change is already archived and was about application behavior, not repo automation.

### Make GitHub Actions run the same Bun-based checks used locally
The CI workflow should call the same commands that contributors are expected to run locally: unit tests, license audit, build, and Playwright E2E. This keeps the local and CI validation paths aligned and reduces "works locally but not in CI" drift.

Alternatives considered:
- Build bespoke CI-only commands: possible, but increases divergence from local workflows.
- Skip E2E in CI and rely on local execution only: simpler, but weaker coverage for the browser-driven behavior that defines the project.

### Keep Playwright and browser automation developer-only
Playwright should remain a repository-development concern. The README and workflows should explain how contributors install the browser runtime and run E2E checks, but the compiled `uatu` artifact should stay focused on the product and not require test tooling.

Alternatives considered:
- Treat browser automation as part of the shipped toolchain: rejected because it confuses contributor tooling with product runtime.
- Omit interactive local E2E guidance from the README: rejected because local iteration is part of the intended developer workflow.

### Use GitHub workflow outputs as the badge boundary
If badges are added now or later, they should reflect GitHub Actions workflow status rather than custom external reporting. That keeps the status surface close to the checks the repository actually runs and avoids inventing a second reporting system.

Alternatives considered:
- Add third-party badge/reporting tooling now: unnecessary for the initial repository workflow setup.
- Delay all badge-related support until much later: possible, but documenting the intended boundary now avoids rework.

### Use GitHub-native update automation to keep versions current
The repository should not rely on manual memory to keep workflow actions and npm packages current. A GitHub-native updater such as Dependabot is the right fit here because it can continuously check GitHub Actions and npm dependencies, open update PRs, and keep the version-currency concern separate from the runtime application itself.

Alternatives considered:
- Manual periodic upgrades only: rejected because it is too easy for repository tooling to drift behind.
- A third-party bot such as Renovate: viable, but Dependabot is sufficient for the initial GitHub-focused setup and requires less extra configuration.

## Risks / Trade-offs

- CI can become slower once Playwright is included -> Use a focused E2E suite and install only the required browser.
- README content can drift from actual commands -> Document only the canonical Bun/OpenSpec commands already used by the repo.
- GitHub Actions setup may need platform-specific tuning later -> Start with a single reliable path and extend only when real needs appear.
- Badge-ready workflows can tempt over-automation too early -> Keep this change focused on validation and contributor clarity, not release engineering.
- Automated dependency updates can add PR churn -> Limit the scope to npm and GitHub Actions so only the most relevant repository tooling stays current.

## Migration Plan

No migration is required. This change can be introduced directly on top of the current repository state by adding the README and workflow files, then using them as the new standard contributor and CI entry points.

## Open Questions

- Whether the first CI workflow should use one job or split validation into multiple parallel jobs for clearer GitHub status reporting.
- Whether badges should be added immediately in the initial `README.md` or only after the workflows have been stable for a short time.
