## ADDED Requirements

### Requirement: Receipt token figures read at their scale
A receipt's token figures SHALL render with compact scale formatting whose
suffix matches the count's magnitude — billion-scale sums included, with a
`B` suffix — and each compact figure SHALL keep the exact count reachable
through the cell's title.

#### Scenario: A billion-scale line item reads in billions
- **WHEN** a receipt line's token sum reaches one billion
- **THEN** the cell reads with the `B` suffix rather than thousands of millions
- **AND** the exact figure remains in the cell's title
