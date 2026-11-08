## ADDED Requirements

### Requirement: Internal worker evidence read excludes transcript payloads

The workspace child SHALL expose a versioned compact authoritative worker-evidence read for one agent-qualified conversation through its existing authenticated internal routing. The read SHALL return only exact worker identities, evidence signatures and active/dismissible facts after establishing complete current source coverage and resolving launcher relationships. It SHALL NOT expose account dismissal marks or ordinary conversation content. It SHALL fail rather than return successful truncated, malformed, contradictory, changed or over-capacity evidence. The Hub SHALL validate version, selected conversation, completeness, bounds and every evidence field before using the result.

#### Scenario: Complete native history
- **WHEN** the provider supplies a complete current source containing a long transcript and large tool outputs
- **THEN** the internal read projects bounded worker facts from that source once without display-history pagination or output serialization

#### Scenario: Failed or truncated source
- **WHEN** the provider supplies only incomplete pages and complete coverage cannot be proven within the existing bounded fallback
- **THEN** the read reports unavailable instead of returning an empty or partial successful worker set

#### Scenario: Page-scoped provenance cannot be combined safely
- **WHEN** a fallback page carries association, origin, hidden-result, fallback, revert or accounting provenance without complete-source coverage
- **THEN** the read refuses that fallback rather than discarding provenance and authorizing a contradictory worker dismissal

#### Scenario: Contradictory duplicate worker source identities
- **WHEN** one current source contains conflicting lifecycle, occurrence or association facts for the same worker row or shared exact execution alias
- **THEN** the read refuses before normalization or deduplication can discard positive activity
- **AND** compatible duplicate observations and independently owned later recovery updates retain their established identity behavior

#### Scenario: Retained cache or missing recovery is weaker than current source
- **WHEN** a current source carries positive or nondismissible worker evidence but retained projection rows or empty/failed recovery carry weaker information
- **THEN** compact evidence preserves the current source evidence or fails unavailable
- **AND** no intermediate deduplication, weak supersession or late cache overwrite authorizes dismissal by discarding that evidence

#### Scenario: Shared exact aliases disagree on immutable occurrence facts
- **WHEN** rows sharing an exact execution alias disagree on known task, child, launcher, result or launch-reference facts
- **THEN** the read refuses even if their lifecycle signatures match
- **AND** unknown intermediate rows and alias-group bridges cannot erase prior known facts
- **AND** explicitly supported compatible legacy alias enrichment remains available

#### Scenario: Native canonical history enriches a call-scoped launcher key
- **WHEN** native history proves multiple launch calls share exact execution aliases and a larger canonical launcher/alias set fully contains an old call-scoped row
- **AND** both rows independently permit dismissal and the old row is running/unavailable without a result, request or end fact
- **AND** native parent/child scope, task-key recipes, launcher anchoring and known generation/launch-reference facts agree
- **THEN** compact evidence discards only that certified abstaining shadow before strict shared-alias cohort validation
- **AND** it does not discard positive or nondismissible activity, conflicting outcomes, same-row conflicts or missing supplemental coverage
- **AND** the projection grants no worker-completion or Stop authority
