## ADDED Requirements

### Requirement: Recent covers known files in ignored folders
Recent SHALL include files inside Git-ignored folders that are known to the index: files in listed levels and files captured by the live-write window. Recent SHALL NOT read unlisted ignored folders to find older writes. A file inside an unlisted ignored folder that was written before the session started SHALL appear in Recent once its level is listed.

#### Scenario: A render written during the session is in Recent
- **WHEN** Show ignored files is on and a script writes `build/renders/take-5.wav` inside an unlisted ignored `build/`
- **THEN** `take-5.wav` appears at the top of Recent and under the Audio filter

#### Scenario: Yesterday's render appears after expansion
- **WHEN** `build/renders/take-0.wav` was written before the session started and `build/renders/` has not been listed
- **THEN** it is absent from Recent until a client expands `build/renders/`, after which it is ordered by its write time
