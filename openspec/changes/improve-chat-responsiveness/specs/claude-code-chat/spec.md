## ADDED Requirements

### Requirement: Claude transcript paging reuses unchanged native history

Repeated paging or reopening of a verified unchanged native Claude Code transcript within the documented reuse limits SHALL avoid rereading, reparsing, and renormalizing the entire transcript for every request. Reusable history SHALL be bounded in memory and isolated by workspace and native transcript identity, including child transcripts and forked histories. Eviction or a transcript larger than those limits SHALL fall back to authoritative reads without losing content. A transcript append, rewrite, replacement, truncation, deletion, or history mutation SHALL invalidate or reconcile affected state before it is returned as current. Uncertain freshness SHALL cause an authoritative read.

The optimization MUST preserve transcript order, parent/child separation, token accounting, model attribution, reversible-history boundaries, and cursor correctness. Reading history SHALL NOT start a turn. Optional catalog readiness MUST NOT prevent displaying available transcript content; catalog-dependent readouts SHALL remain explicitly unknown until reliable metadata arrives.

#### Scenario: Adjacent pages share unchanged transcript work
- **WHEN** a user requests several pages from a retained transcript within the reuse limits verified unchanged since the first read
- **THEN** later pages reuse the verified result without repeating full transcript processing
- **AND** messages and usage remain correctly ordered and attributed

#### Scenario: Transcript changes outside the current browser
- **WHEN** a transcript is appended, rewritten, replaced, truncated, or deleted by the provider or another client
- **THEN** subsequent history reads reconcile the changed source
- **AND** no stale completed history is returned as authoritative

#### Scenario: Native history is available before the model catalog
- **WHEN** a stored conversation can be read but its optional model catalog is still loading
- **THEN** its transcript becomes readable without starting a turn or waiting for that catalog
- **AND** unresolved model-dependent values are presented as unknown until resolved
