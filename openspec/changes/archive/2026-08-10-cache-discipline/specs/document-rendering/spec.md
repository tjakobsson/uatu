# document-rendering — delta

## REMOVED Requirements

### Requirement: Show a stale-content hint in Review when the active file changes on disk
**Reason**: Vestigial since Modes were removed: the single-mode app reloads the active file in place on change (follow-mode Rule D), no code path can construct a stale-content hint (`nextStaleHint` never returns a new hint), and the requirement's Review/Author framing describes UI that no longer exists. The remaining machinery is deleted with this change.
**Migration**: None — the specified behavior has not been observable since the Modes removal; live reload of the active document is the standing behavior.
