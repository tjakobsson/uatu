# document-diff-view — delta for declutter-sidebar-defaults

The diff view's Selection Inspector requirement mixed retired-pane behavior
with a still-valid DOM contract. The pane behavior goes; the contract that
Diff DOM never carries the whole-file source distinguishing class stays (the
word-wrap control keys off that class).

## REMOVED Requirements

### Requirement: Diff view selection is not captured by the Selection Inspector
**Reason**: The Selection Inspector capability is retired; there is no pane left to capture or hint about selections.
**Migration**: The surviving DOM contract moves to the new "Diff view DOM omits the whole-file source distinguishing class" requirement.

## ADDED Requirements

### Requirement: Diff view DOM omits the whole-file source distinguishing class
The whole-file source `<pre>` distinguishing class (used by single Source view and the Source pane of split layouts) MUST NOT appear on Diff-view DOM, so class-keyed consumers (for example the word-wrap control) never treat Diff content as the whole-file source block.

#### Scenario: Diff view DOM omits the source-pre distinguishing class
- **WHEN** the Diff view is rendered for any document
- **THEN** the preview body does not contain a `<pre>` element carrying the whole-file source-view distinguishing class
