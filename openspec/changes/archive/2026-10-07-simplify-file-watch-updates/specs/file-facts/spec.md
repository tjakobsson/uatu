## MODIFIED Requirements

### Requirement: File facts ride the document render payload

The server SHALL compute filesystem facts for every document render and attach them to the `/api/document` payload when available. Facts SHALL include the line count and byte size for the rendered source and its observed modification time. Source and Rendered content delivery MUST NOT wait for Git subprocesses. For documents inside a Git root, the client SHALL obtain the last commit touching the file and its clean, dirty, or uncommitted state independently and enrich the facts strip when available. Pending, stale, and unavailable Git facts SHALL be distinguishable from verified clean or uncommitted facts. Filesystem facts SHALL refresh with every render, and Git enrichment SHALL be scoped to the selected document, content revision, and repository generation. Obsolete enrichment MUST NOT replace newer facts. Git failure SHALL leave the document and filesystem facts usable.

#### Scenario: Document in a git root
- **WHEN** the client fetches a committed document
- **THEN** it can display rendered content and filesystem facts before Git lookup finishes
- **AND** matching Git facts subsequently supply author, date, short SHA, and clean or dirty state

#### Scenario: Document in a non-git root
- **WHEN** the client fetches a file from a non-Git watched root
- **THEN** the payload includes line count, byte size, and modification time with no Git fields
- **AND** no indefinite Git-loading indicator is displayed

#### Scenario: File never committed
- **WHEN** independent Git lookup confirms that no commit touches the selected file
- **THEN** the facts strip marks it uncommitted with no last-commit fields
- **AND** a pending lookup alone is not treated as that confirmation

#### Scenario: Git lookup fails
- **WHEN** a Git subprocess errors, times out, or remains pending
- **THEN** document rendering and file-change reloads continue without waiting for it
- **AND** the facts strip reports unavailable or pending provenance alongside filesystem facts

#### Scenario: Old facts arrive after another save
- **WHEN** an enrichment request for an older file revision finishes after a new save or navigation
- **THEN** it cannot overwrite the current strip or cause another document render
