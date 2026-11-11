# media-playback Specification

## Purpose
Let users preview audio and video files directly from Files, with one controllable player that remains available while browsing other application surfaces.

## Requirements

### Requirement: Audio and video files have paused previews

Recognized audio/video filename selection SHALL open an in-app player without implicit Play. Navigation, personal resume, discovery, and updates MUST NOT start playback without explicit Play. Playback support SHALL depend on the actual browser, container, and codec. Decode failure SHALL retain file identity, permitted download, and explicit retry. Listing MUST NOT preload each clip or analyze full media for waveforms/thumbnails.

#### Scenario: Navigate to a clip without granting Play intent
- **WHEN** a clip is reached by preview selection, direct link, history, personal resume, discovery, or file update
- **THEN** playback MUST NOT start without an explicit Play action
- **AND** reopening the playing clip presents its existing session uninterrupted; previewing another clip shows a paused Play affordance without replacing that session until Play

#### Scenario: Decode failure is not a missing document
- **WHEN** the actual browser/container/codec cannot decode the clip or decoding fails
- **THEN** the preview retains file identity and offers permitted download and explicit retry instead of a document-not-found error

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

Recent SHALL offer keyboard- and touch-operable Play for recognized media rows, separate from filename selection. Audition SHALL retain Files, the current preview and preview URL, and disable Follow. Hierarchical views SHALL offer Play and Open preview in row actions. Starting another clip SHALL stop and release the previous one before playing at zero. Denied browser Play SHALL expose an actionable state without automatic retry loops.

#### Scenario: Audition without preview navigation
- **WHEN** a media row's Play action is activated by keyboard or touch
- **THEN** it plays that clip and disables Follow while leaving Files, the current preview, and its URL unchanged
- **AND** another active clip is stopped and released before the selected clip starts at zero

#### Scenario: The browser refuses an audition
- **WHEN** the browser denies the Play request
- **THEN** the user sees an actionable refusal state without an automatic retry loop

#### Scenario: The user compares two snippets on a phone
- **WHEN** the user presses Play on one Recent row and then on another
- **THEN** Files remains visible, the second clip starts at zero, and only the second clip plays
- **AND** neither action requires a Files/Preview tab round trip or changes the preview URL

#### Scenario: The filename is activated instead
- **WHEN** the user activates a media filename rather than its Play action
- **THEN** normal manual preview navigation opens that file paused

### Requirement: One persistent player survives application-surface changes

One page-local player SHALL own the active clip across Files, Preview, Chat, Terminal, and desktop/touch layout changes, with the controls below. Video SHALL offer expansion and fullscreen where supported. Preview and compact presentation MUST NOT overlap playback. Close SHALL release the source and pending transfers. Full-page/workspace navigation ends the session; reload SHALL NOT restore active playback automatically.

#### Scenario: Operate the page's persistent player
- **WHEN** a player session is active on any application surface or layout
- **THEN** it provides file identity, Play/Pause, seeking, elapsed time and duration when known, Previous/Next, current-clip Loop, and Close
- **AND** presenting that clip in Preview and compact form MUST NOT create overlapping playback

#### Scenario: Leave or reload the player page
- **WHEN** full-page/workspace navigation or reload ends the page-local session
- **THEN** the old session ends, and reload does not automatically restore active playback

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

Row audition SHALL capture the current eligible media order. Previous/Next SHALL traverse it without wrapping, skip unavailable entries, and start at zero. Later arrivals and filter changes MUST NOT silently reorder it, and clip completion MUST NOT advance automatically.

#### Scenario: Capture the audition's complete selection context
- **WHEN** a row is explicitly played
- **THEN** a new order captures eligible media in the current Files view, filename/path query, ignored visibility, and media-type filter
- **AND** later arrivals or view/filter changes MUST NOT silently reorder that session

#### Scenario: Traverse only the captured eligible order
- **WHEN** Previous or Next is activated
- **THEN** it skips removed or no-longer-permitted entries, does not wrap, and starts the chosen clip at zero

#### Scenario: Apply current-clip Loop at completion
- **WHEN** the active clip ends
- **THEN** playback stops unless current-clip Loop is enabled; it MUST NOT advance to another clip automatically

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

Unrelated updates SHALL preserve playback. A write to the active clip SHALL expose an explicit Reload, invalidate obsolete transfers, and prevent old-revision looping. Reload SHALL select the latest revision paused at zero; deleted or excluded clips SHALL stop, and write time MUST NOT imply producer completion.

#### Scenario: A write invalidates the active revision
- **WHEN** a write to the active file is detected
- **THEN** New render available and Reload appear, pending old-revision transfers are invalidated, and further automatic looping of that revision is prevented
- **AND** buffered playback continues only without obsolete transfers; otherwise it pauses with the update notice

#### Scenario: Explicitly reload or lose access to the clip
- **WHEN** Reload is activated
- **THEN** the latest revision is selected paused at zero
- **WHEN** the clip is deleted or exposure-excluded
- **THEN** playback stops and shows unavailable state

#### Scenario: Unrelated changes and timestamps grant no playback intent
- **WHEN** an unrelated live update arrives or a recent write time is displayed
- **THEN** unrelated updates leave source and time unchanged, and write time MUST NOT be presented as proof the producer finished rendering

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
