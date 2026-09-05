## ADDED Requirements

### Requirement: Manual selection survives background reconciliation

While Follow is off and a file is selected, filesystem updates, index reconciliation, reconnects, page resume, and programmatic tree updates SHALL preserve that file's identity and browser URL. This applies to every selectable file, including text, Markdown, images, and files with an unavailable-preview presentation. A change in file classification MUST NOT select a different file. Existing explicit navigation and enabling Follow remain intentional ways to change selection. An update to the selected file SHALL refresh its available content in place without moving focus or the active touch tab.

#### Scenario: Text selection survives unrelated edits
- **WHEN** Follow is off, the user is viewing a Markdown or source file, and another file changes repeatedly
- **THEN** the selected file, preview identity, URL, focus, and active tab remain unchanged
- **AND** the tree reflects the background changes

#### Scenario: Image selection survives a state update
- **WHEN** Follow is off, an image is selected, and a background update or reconnect supplies a workspace snapshot
- **THEN** the image remains selected and its URL is preserved

#### Scenario: Resume preserves the current file
- **WHEN** a suspended page resumes with Follow off after workspace files have changed
- **THEN** reconciliation preserves the selected file and URL
- **AND** updated content for that file is refreshed in place

### Requirement: Unavailable manual selections retain their destination

With Follow off, a selected file that disappears from the allowed index SHALL remain the selected destination and SHALL display a named unavailable state instead of a different file. Its previous contents MUST NOT be presented as current contents. The destination SHALL survive an empty index and a classification change. If the same file path becomes available again, its preview SHALL recover automatically only while that destination is still selected. Index removal caused by ignore or exposure rules MUST NOT be bypassed to read a retained destination. A renamed file SHALL be treated as an unavailable old path until explicit navigation chooses its new path.

#### Scenario: File is replaced during an edit
- **WHEN** the selected file is absent from one snapshot and returns in a later snapshot while Follow remains off
- **THEN** the preview shows unavailability during the gap, retains its destination and URL, and then renders the returned file
- **AND** no fallback file is selected during the gap

#### Scenario: File stays deleted
- **WHEN** the selected file is deleted and does not return
- **THEN** its unavailable presentation remains until the user navigates or enables Follow
- **AND** the user can still select other files

#### Scenario: User leaves before a file returns
- **WHEN** the user selects another file while the previous destination is unavailable and the previous file subsequently returns
- **THEN** the newer selection and URL remain unchanged

### Requirement: Asynchronous work cannot override newer navigation

Only work belonging to the current selection and preview mode SHALL update the preview, selection chrome, or URL. Late responses and programmatic selection notifications MUST NOT be interpreted as new user navigation. Genuine pointer and keyboard navigation SHALL continue to work immediately after a programmatic tree refresh.

#### Scenario: Previous file response completes late
- **WHEN** file A is loading, the user selects file B, and A's response finishes after B's
- **THEN** the preview, selected tree entry, and URL continue to identify B

#### Scenario: Tree rebuild does not navigate
- **WHEN** a file update or filter refresh rebuilds the tree and the tree reports a programmatic selection
- **THEN** that notification does not change the user's selected file, Follow setting, or active tab
- **AND** a subsequent genuine row activation navigates normally

#### Scenario: Client selections remain independent
- **WHEN** two clients select different files with Follow off and either client receives background updates
- **THEN** each client retains its own selected destination
