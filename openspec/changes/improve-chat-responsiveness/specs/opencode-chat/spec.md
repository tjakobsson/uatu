## ADDED Requirements

### Requirement: OpenCode history reuse preserves authoritative pagination

Repeated paging through a verified unchanged OpenCode conversation within the documented reuse limits SHALL avoid a complete provider-history traversal for each page. Reusable history SHALL be bounded in memory and isolated by workspace and conversation. Eviction or a history larger than those limits SHALL fall back to authoritative reads without losing content. Native provider history remains authoritative: content edits, new messages, undo, redo, revert, restore, deletion, and replay gaps SHALL invalidate or reconcile affected reusable state before it is represented as current. When freshness cannot be established, the system SHALL perform authoritative reconciliation rather than return an unverified history snapshot as current.

History optimization MUST preserve the existing merge of supported provider stores, normalized ordering, accounting, child attribution, and the snapshot-to-stream boundary. Older-page cursors SHALL either deliver correctly ordered, nonduplicated history or explicitly require a fresh snapshot when no longer applicable.

#### Scenario: Repeated reads of unchanged history
- **WHEN** a client requests adjacent pages of a retained conversation within the reuse limits whose source version is verified unchanged
- **THEN** the server reuses the verified history without traversing all provider pages again for each request
- **AND** page boundaries contain no duplicates or omissions

#### Scenario: History changes after reuse was established
- **WHEN** a history mutation, external edit, or replay gap invalidates previously read history
- **THEN** the next authoritative snapshot reflects the changed history
- **AND** incompatible older cursors do not silently skip or repeat messages

#### Scenario: Compatibility history remains complete
- **WHEN** supported provider stores contain different portions of a conversation
- **THEN** optimized history includes the same merged content as authoritative reconciliation
- **AND** an unavailable store is not silently treated as empty unless its response is an established missing-store condition
