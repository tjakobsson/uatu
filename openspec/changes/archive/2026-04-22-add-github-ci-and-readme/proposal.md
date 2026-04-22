## Why

The project now has a working application, tests, and an archived product change, but it still lacks the repository-level workflow that makes the work maintainable and visible to contributors. Adding a root README and GitHub Actions now will make the project easier to understand locally and will create a clean base for later repository automation such as badges, Scorecards, and additional GitHub-native checks.

## What Changes

- Add a root `README.md` that explains what `uatu` is, how to run it locally, how to run tests, and how the repository uses OpenSpec.
- Add GitHub Actions workflows to run the core validation checks on GitHub, including unit tests, license audit, build, and Playwright E2E coverage.
- Add repository automation to keep npm packages and GitHub Actions versions current instead of letting workflow/tooling versions drift.
- Add badge-friendly workflow outputs and documentation references so repository health can be surfaced from GitHub over time.
- Capture the repository workflow expectations in OpenSpec so future automation work has a stable spec baseline.

## Capabilities

### New Capabilities
- `repository-workflows`: Define contributor-facing repository documentation and automated validation workflows for the project.

### Modified Capabilities

None.

## Impact

- Introduces the first root-level project documentation.
- Adds GitHub Actions workflow files and CI configuration.
- Adds repository automation for dependency and workflow version currency.
- Uses the existing Bun, Playwright, and OpenSpec command surface as required validation steps.
- Establishes the repository foundation for future GitHub-focused automation such as badges and Scorecards.
