## MODIFIED Requirements

### Requirement: Web page JavaScript dialogs present natively
JavaScript `alert()`, `confirm()`, and `prompt()` raised by pages in the embedded WebView SHALL present as native panels attached to the window and return the user's answer to the page: `alert()` returns after dismissal, `confirm()` returns true only when the user confirms, and `prompt()` returns the entered text on OK (with the page's default text prefilled) and null on Cancel. A page's file input (`<input type="file">`) SHALL open the system open panel, honouring the input's single-or-multiple setting, and return the chosen files to the page; cancelling returns no files. WKWebView shows no JS dialogs or file chooser without app-provided implementations — it silently answers false, null, or nothing — which would turn the hub dashboard's confirmation-gated actions (stop, initialize-and-serve) into dead controls and leave its private-key file input unable to pick a file.

#### Scenario: Dashboard confirmations work in the desktop
- **WHEN** a hub page calls `confirm()` (e.g. the dashboard's stop confirmation)
- **THEN** a native dialog appears in the window
- **AND** confirming returns true to the page so the action proceeds

#### Scenario: A prompt returns the entered text
- **WHEN** a page in the embedded WebView calls `prompt("Name?", "draft")`
- **THEN** a native panel with a text field prefilled with `draft` appears
- **AND** OK returns the field's text to the page and Cancel returns null

#### Scenario: A file input opens the system picker
- **WHEN** the user activates the hub dashboard's "Private key file" input
- **THEN** the system open panel appears
- **AND** choosing a file populates the input, and cancelling leaves it empty
