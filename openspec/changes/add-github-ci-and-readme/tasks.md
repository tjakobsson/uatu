## 1. Repository documentation

- [x] 1.1 Add a root `README.md` describing `uatu`, its local usage, and the current Markdown-focused scope.
- [x] 1.2 Document the repository validation commands for unit tests, license audit, build, and Playwright E2E.
- [x] 1.3 Document the OpenSpec workflow used by the repository, including how active changes and archived changes fit together.

## 2. GitHub Actions validation

- [x] 2.1 Add a GitHub Actions workflow that runs the repository validation checks on GitHub.
- [x] 2.2 Configure the workflow to install Bun dependencies and the Playwright browser runtime needed for E2E execution.
- [x] 2.3 Ensure the workflow runs the same canonical commands used locally: `bun test`, `bun run check:licenses`, `bun run build`, and `bun run test:e2e`.

## 3. Version currency automation

- [x] 3.1 Add GitHub-native automation to check for npm and GitHub Actions updates.
- [x] 3.2 Ensure the new automation keeps repository tooling current without affecting the shipped `uatu` runtime.

## 4. Reporting and verification

- [x] 4.1 Add README references or placeholders for GitHub-native workflow status reporting such as badges.
- [x] 4.2 Verify the repository documentation matches the implemented commands, workflow names, and update automation.
- [x] 4.3 Run the documented validation commands locally and confirm the new workflow files are ready for GitHub execution.
