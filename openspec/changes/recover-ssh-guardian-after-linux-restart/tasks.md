## 1. Version Guardian Ownership

- [x] 1.1 Read and strictly validate the current Linux boot ID while retaining a no-boot-ID fallback for unsupported platforms or unavailable procfs.
- [x] 1.2 Extend the private supervisor startup message and ownership parser with a version-3 boot identity while continuing to accept the shipped exact version-2 ownership format.
- [x] 1.3 Have fresh Linux guardians commit version-3 ownership and keep version-2 behavior when no valid boot identity is available.

## 2. Recover Previous-Boot State

- [x] 2.1 Detect ownership records proven to come from a different Linux boot before attempting guardian control communication.
- [x] 2.2 Validate every remaining socket against its recorded owner, mode, type, device, and inode, allow already-missing sockets, and remove the revalidated ownership record last without signaling recorded PIDs.
- [x] 2.3 Preserve all unprovable or mismatched state and replace the generic guardian request error with safe, actionable operator guidance.

## 3. Verify Compatibility And Safety

- [x] 3.1 Add tests for version-3 ownership creation and continued parsing of shipped version-2 records.
- [x] 3.2 Add WSL-style abrupt-shutdown tests covering partial socket cleanup, automatic cross-boot recovery, and preservation on identity mismatch.
- [x] 3.3 Run the focused SSH guardian suites, TypeScript type checking, the full test suite under a clean tool environment, and the compiled-binary build.
