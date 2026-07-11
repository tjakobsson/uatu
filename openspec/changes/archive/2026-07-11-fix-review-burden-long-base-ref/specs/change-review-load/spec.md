## ADDED Requirements

### Requirement: Render precise review-burden anchors within the available meter width

The Change Overview SHALL render the complete precise compare-target anchor within the review-burden meter without horizontal overflow. When the resolved ref is too long for the available width, the anchor MUST wrap while the review-burden headline, classified level, and numeric score remain visible and readable.

#### Scenario: Long configured base ref in a narrow sidebar

- **WHEN** the review burden is measured against a configured base ref whose anchor does not fit on one line in the Change Overview sidebar
- **THEN** the complete anchor wraps within the review-burden meter
- **AND** the meter does not overflow horizontally
- **AND** the review-burden headline, classified level, and numeric score remain visible

#### Scenario: Short compare-target anchor

- **WHEN** the precise compare-target anchor fits within the available review-burden meter width
- **THEN** the meter displays the complete anchor without unnecessary truncation
- **AND** the review-burden headline, classified level, and numeric score remain visible
