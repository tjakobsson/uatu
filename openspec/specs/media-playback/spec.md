# media-playback Specification

## Purpose
Let users preview audio and video files directly from Files, with one controllable player that remains available while browsing other application surfaces.

## Requirements

### Requirement: Audio and video files have paused previews
Recognized audio and video files SHALL open in an in-app player when their filename is selected. Preview selection, direct links, history, personal resume, discovery, and file updates MUST NOT start playback without an explicit Play action. Returning to an already playing clip's preview SHALL present its existing session without interrupting it; previewing a different clip SHALL show a paused Play affordance without replacing that session until Play is pressed. Supported playback SHALL depend on actual browser/container/codec support. Unsupported or failed decoding SHALL retain file identity and offer a permitted download and explicit retry action rather than a document-not-found error. Listing files MUST NOT preload each clip or compute waveforms/thumbnails from complete media contents.

#### Scenario: A WAV file is selected
- **WHEN** the user opens a recognized WAV file by its filename
- **THEN** Preview shows that file's paused player and playback controls
- **AND** it does not request the document-render API for media content

#### Scenario: A MOV codec is unsupported
- **WHEN** the browser cannot decode the selected MOV file
- **THEN** the preview explains playback is unavailable and offers its allowed download
- **AND** it does not claim all files with the same extension are playable

#### Scenario: Recent contains many clips
- **WHEN** the list displays many audio/video entries
- **THEN** their appearance alone initiates no media-source requests or full-file analysis

#### Scenario: The active clip's preview is reopened
- **WHEN** the user opens the filename of the clip already playing
- **THEN** its existing session and time are presented without another source or a playback interruption

### Requirement: Quick audition is separate from preview navigation
Recent SHALL offer a keyboard- and touch-operable Play action for recognized media rows, separate from filename selection. Activating it SHALL play that clip while retaining the Files surface, current preview, and preview URL, and SHALL disable Follow as explicit audition intent. Hierarchical views SHALL offer Play and Open preview through their row actions. Starting another clip SHALL stop and release the previous clip before playing the new one at time zero. A denied browser Play request SHALL surface an actionable state without an automatic retry loop.

#### Scenario: The user compares two snippets on a phone
- **WHEN** the user presses Play on one Recent row and then on another
- **THEN** Files remains visible, the second clip starts at zero, and only the second clip plays
- **AND** neither action requires a Files/Preview tab round trip or changes the preview URL

#### Scenario: The filename is activated instead
- **WHEN** the user activates a media filename rather than its Play action
- **THEN** normal manual preview navigation opens that file paused

### Requirement: One persistent player survives application-surface changes
One page-local player session SHALL own the active clip across Files, Preview, Chat, Terminal, and desktop/touch layout changes. It SHALL provide file identity, play/pause, seeking, elapsed time and duration when known, Previous/Next, current-clip Loop, and Close. Video SHALL have an expandable presentation and fullscreen where supported. Showing the same clip in Preview and a compact player MUST NOT create overlapping playback. Closing the player SHALL release its source and pending transfers. Full-page/workspace navigation ends the session, and reload SHALL NOT restore active playback automatically.

#### Scenario: Chat opens during an audition
- **WHEN** a clip is playing and the user opens Chat or browses another folder
- **THEN** the same session and playback position continue with reachable player controls

#### Scenario: A video expands
- **WHEN** the user expands the currently playing video
- **THEN** its playback position is preserved and no second audible player starts

#### Scenario: The user closes playback
- **WHEN** Close is activated
- **THEN** playback stops, pending transfers are cancelled, and the compact player is removed

### Requirement: Previous and Next follow an explicit audition order
Starting a row audition SHALL capture the currently ordered eligible media results under the selected Files view, filename/path query, ignored visibility, and media-type filter. Previous/Next SHALL traverse that order without wrapping, skipping removed or no-longer-permitted entries, and start each chosen clip at zero. Later arrivals and view/filter changes MUST NOT silently reorder that session. Playing a row explicitly SHALL establish a new order. End-of-clip SHALL stop unless current-clip Loop is enabled; it MUST NOT advance automatically.

#### Scenario: A new render arrives during comparison
- **WHEN** the user is auditioning A then B and a newer C appears in Recent
- **THEN** Next retains the established order rather than inserting C unexpectedly
- **AND** explicitly playing C starts a new audition order

#### Scenario: There is no next clip
- **WHEN** the active item is the final surviving entry in its audition order
- **THEN** Next is disabled and playback does not wrap to the first entry

#### Scenario: A clip finishes
- **WHEN** the clip ends with Loop off
- **THEN** playback stops without automatically starting another clip

### Requirement: Files can filter audio and video independently of Git changes
Files SHALL offer All types, Audio, and Video filters across All, Recent, and Changed. Type filtering SHALL compose with filename/path matching and ignored visibility, update the current count, and preserve preview/playback selection. Audio/Video membership SHALL use recognized media classification and MUST NOT depend on Git tracking or change status. Unknown codec support SHALL not hide a recognized candidate before an explicit playback attempt.

#### Scenario: The user wants recent video renders
- **WHEN** Recent and Video are selected with ignored files shown
- **THEN** matching permitted video candidates appear newest-first, including ignored renders
- **AND** audio, source files, and unrelated binaries do not appear

### Requirement: Active media updates are explicit and revision-aware
Unrelated live updates SHALL leave the player source and time unchanged. A detected write to the active file SHALL show New render available with Reload, invalidate pending old-revision transfers, and prevent further automatic looping of that old revision. Already buffered playback SHALL continue only while it can do so without obsolete transfers; otherwise it SHALL pause with the update notice. Reload SHALL select the latest revision at zero and leave it paused. Deleted/exposure-excluded clips SHALL stop and show unavailable state. Recent write time MUST NOT be presented as proof the producer has finished rendering.

#### Scenario: A looping audio file is overwritten
- **WHEN** the active file's revision changes while Loop is enabled
- **THEN** the user sees New render available without a silent restart into the new content
- **AND** Reload loads the latest revision paused at zero

#### Scenario: A renderer is still writing
- **WHEN** the newest file is incomplete or cannot yet be decoded
- **THEN** its actual write time remains visible and an explicit retry/reload is available
- **AND** the application does not autoplay or indefinitely retry on a settling timer

#### Scenario: A clip becomes explicitly excluded
- **WHEN** project exposure policy removes the active clip
- **THEN** the session stops and does not keep issuing media requests for that file
