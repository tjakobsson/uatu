## ADDED Requirements

### Requirement: Browser tabs present JavaScript dialogs and the file chooser natively
A page in a split-browser tab that calls `alert()`, `confirm()`, or `prompt()` SHALL get a native panel attached to the window, and the user's answer SHALL be returned to the page with the same semantics as the embedded uatu WebView: `alert()` returns after dismissal, `confirm()` returns true only on confirmation, `prompt()` returns the entered text or null on Cancel. A page's file input SHALL open the system open panel and return the chosen files. A dialog raised by a tab that is not the selected tab MUST NOT be shown over another tab's page; it is presented when its tab becomes selected, and the page waits until then. The split MUST NOT silently answer a dialog on the page's behalf.

#### Scenario: A confirmation in a browser tab works
- **WHEN** a page in the selected browser tab calls `confirm()` before an action
- **THEN** a native dialog appears in the window
- **AND** confirming returns true so the page's action proceeds, and cancelling returns false

#### Scenario: An alert in a browser tab is shown
- **WHEN** a page in the selected browser tab calls `alert()`
- **THEN** a native panel shows the message and the page continues after dismissal

#### Scenario: A background tab's dialog waits for its tab
- **WHEN** a page in a non-selected tab calls `confirm()`
- **THEN** no dialog appears over the selected tab
- **AND** selecting that tab presents the dialog, and answering it returns the answer to the page
