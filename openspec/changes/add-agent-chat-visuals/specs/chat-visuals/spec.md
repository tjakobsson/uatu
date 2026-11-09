# chat-visuals Specification Delta

## Purpose

Let agents communicate with inline images while preserving the conversation's
reading behavior, original SVG source, and workspace access boundaries.

## ADDED Requirements

### Requirement: Explicit assistant visuals render inside chat
Assistant replies SHALL present PNG, JPEG, and SVG referenced by Markdown
images, and fenced SVG, inline without requiring a new tool or skill.
Ordinary links and native tool-result image blocks SHALL NOT be implicitly
converted into visuals. User attachment formats and policy SHALL remain unchanged.

#### Scenario: An agent shares a workspace screenshot
- **WHEN** an assistant embeds a permitted workspace PNG or JPEG using Markdown image syntax
- **THEN** the image appears in its reply without leaving chat
- **AND** its path is resolved relative to the agent workspace, not the open Preview document

#### Scenario: An agent shares SVG
- **WHEN** an assistant embeds a permitted SVG file or completes a fenced SVG block
- **THEN** chat offers an inline preview for a supported, self-contained SVG
- **AND** a valid viewBox-only SVG needs no explicit width or height attributes

#### Scenario: A tool returns an image without an embed
- **WHEN** an image exists only as a native tool-result block or an ordinary link
- **THEN** no assistant visual is created automatically

#### Scenario: A surface has no captured visual references
- **WHEN** a plan preview, subagent report, or aside answer renders without visual snapshots
- **THEN** fenced SVG remains visible, copyable code rather than an unavailable preview
- **AND** image references remain inert text or explicit links without automatic source requests

### Requirement: Visuals become available while a reply streams
Chat SHALL recognize visuals as their syntax becomes available during
streaming. An unfinished SVG fence SHALL show a generating state rather than
render partial SVG. A genuinely missing local file SHALL be attempted once
during streaming and retried once at completion; a terminal refusal SHALL
not cause repeated file reads on later deltas or reloads.

#### Scenario: An SVG fence arrives incrementally
- **WHEN** an SVG fence has opened but its closing fence has not arrived
- **THEN** chat shows a generating state
- **AND** closing the fence makes the completed SVG eligible for capture and preview

#### Scenario: A local file is created before completion
- **WHEN** a complete image reference initially names a missing file and the file becomes available before the reply finishes
- **THEN** chat retries capture at completion and shows the captured image
- **AND** repeated streaming deltas do not repeatedly retry it

#### Scenario: A missing file stays missing
- **WHEN** the completion retry still cannot find the referenced file
- **THEN** chat shows an unavailable reference without retrying it on later history loads

### Requirement: Captured occurrences are immutable across provider lifecycles
Each logical visual occurrence SHALL retain its first captured content across
source edits, deletion, replay, reload, and workspace restart. Streaming-to-
completed provider ID changes and HTML repair SHALL NOT change its identity.
A new occurrence SHALL be required to capture changed content. Unsafe SVG
source retained for inspection SHALL be immutable even without a preview.

#### Scenario: A captured image's original is deleted
- **WHEN** a captured PNG, JPEG, or SVG file is changed or deleted
- **THEN** its existing occurrence still shows the captured bytes after completion and a fresh history load
- **AND** any retained SVG source is unchanged

#### Scenario: Claude finalizes a streaming text block
- **WHEN** a streaming occurrence's provider replaces the transient item with a durable transcript item
- **THEN** the completed reply and reloaded native history resolve the same captured occurrence
- **AND** the file is not captured again under the durable item ID

#### Scenario: HTML repair reorders image elements
- **WHEN** appending content to a table changes the parsed image order
- **THEN** existing source occurrences keep their snapshots
- **AND** new images have distinct occurrence identities and correctly matched previews

### Requirement: Visual capture respects workspace file authority
Capturing a local visual SHALL preserve existing watched-root, deny-path,
ignore, traversal, and symlink protections. Assistant visuals SHALL be
limited to 10 MiB each and eight occurrences per message, including refused
occurrences. Capture work SHALL be bounded rather than allowing unbounded
concurrent image reads.

#### Scenario: An image path is not permitted
- **WHEN** an embed targets an ignored, denied, outside-workspace, traversal, or disallowed symlink path
- **THEN** no file content is imported or served as a visual
- **AND** chat preserves an inert reference and an explanation

#### Scenario: A reply exceeds the visual bounds
- **WHEN** an image exceeds 10 MiB or a reply contains more than eight visual occurrences
- **THEN** excess content is refused with an explanation
- **AND** permitted visuals and the rest of the reply remain usable

### Requirement: Admission is stable across changes in presentation order
The first eight observed logical visual occurrences in a message SHALL own
its admission slots, including pending or refused occurrences. Reordering,
later reference resolution, source removal, and reload SHALL NOT evict an
admitted occurrence or make room for a ninth one. Presentation indexes SHALL
NOT grant new capture authority.

#### Scenario: HTML repair moves a ninth occurrence before admitted images
- **WHEN** eight occurrences have been admitted and appended HTML moves a ninth image earlier in rendered order
- **THEN** the original eight retain their admission and captured content
- **AND** the ninth occurrence is refused without being captured

#### Scenario: A late reference resolves before admitted images
- **WHEN** a later Markdown definition resolves an earlier reference after eight other occurrences have been admitted
- **THEN** it cannot displace an admitted occurrence or cause a ninth capture
- **AND** reloading the conversation preserves those admission decisions

### Requirement: Intermediate test state is preserved without admission compatibility
Existing stored files, IDs, and bytes SHALL remain untouched and resolvable.
Admission choices from intermediate unreleased test builds are not migrated;
an old test conversation can display a different set of up to eight previews.
The permanent admission guarantee SHALL begin on first processing by the new
implementation.

#### Scenario: An intermediate test conversation is processed by the new build
- **WHEN** a conversation with captures from an intermediate unreleased build is first processed
- **THEN** it starts a permanent admission ledger without prioritizing older captures
- **AND** existing stored bytes and identifiers remain preserved and resolvable

### Requirement: Visuals cannot automatically load external resources
The browser and server SHALL NOT automatically fetch original external image
URLs or SVG dependencies. SVG previews SHALL be inert image documents, never
active SVG in the chat DOM. Scripts, embedded HTML, and external resources
SHALL be refused. Original source and fallback references SHALL be rendered
as inert text; an external reference MAY be followed only by explicit user action.

#### Scenario: A reply embeds a remote image
- **WHEN** an assistant uses an external URL as an image source
- **THEN** no automatic browser or server request reaches that URL
- **AND** the reply retains a user-activated reference instead of a preview

#### Scenario: An SVG contains active or external content
- **WHEN** bounded SVG source contains scripts, foreignObject, or an external resource reference
- **THEN** no SVG preview is served
- **AND** its original source remains available as inert text

### Requirement: Invalid or unavailable previews degrade gracefully
Invalid, undecodable, or unavailable image previews SHALL produce a readable
fallback without breaking the remaining reply or throwing an uncaught error.
The fallback SHALL preserve the original reference and any retained SVG
source. A browser preview failure SHALL NOT silently replace stored content
by recapturing its source file.

#### Scenario: A raster image cannot be decoded
- **WHEN** a captured PNG or JPEG is invalid or the browser cannot decode it
- **THEN** chat replaces the broken preview with a readable explanation and retains its reference
- **AND** the remaining reply stays usable without an uncaught error

#### Scenario: A preview request is unavailable
- **WHEN** an issued preview can no longer be loaded
- **THEN** chat provides a readable fallback instead of leaving only a broken-image control
- **AND** any retained SVG source stays accessible without recapturing the original file

### Requirement: Original SVG source stays accessible and copyable
SVG visuals SHALL offer accessible Preview, Source, and Copy source actions.
Source and copying SHALL preserve the original captured SVG rather than a
sanitized or highlighted reconstruction. Clipboard or source-read failure
SHALL provide perceivable feedback without changing conversation content
or throwing an uncaught error.

#### Scenario: The user copies a fenced SVG
- **WHEN** the user selects Copy source on a captured fenced SVG
- **THEN** the clipboard receives only the original SVG content and its source line breaks
- **AND** fence delimiters and visual controls are excluded

#### Scenario: Source fetching or copying fails
- **WHEN** reading stored SVG source or writing the clipboard fails
- **THEN** chat reports that failure accessibly
- **AND** the reply remains readable and its source or preview is not overwritten

### Requirement: Visual presentation preserves chat reading behavior
Visuals SHALL fit the available message width without cropping or distorting
their aspect ratio in desktop and touch layouts. Tall visuals SHALL remain
in conversation flow. Users SHALL be able to enlarge an image within chat
and dismiss the viewer. Image layout changes SHALL obey the existing
reading-anchor and follow-intent requirements.

#### Scenario: A viewBox-only SVG is shown on a phone
- **WHEN** a supported viewBox-only SVG renders in a narrow touch chat
- **THEN** it has nonzero rendered dimensions, preserves its aspect ratio, and fits the message width
- **AND** its enlarged viewer remains within the visible viewport

#### Scenario: A preview loads while the reader is scrolled away
- **WHEN** an image decodes or its streaming presentation changes while the user reads earlier content
- **THEN** chat preserves the reading anchor and does not resume following latest output

#### Scenario: The reader requests Latest with a focused touch composer
- **WHEN** the reader taps Latest on a touch device while the composer has focus
- **THEN** the first tap activates Latest without losing its target to a focus-driven layout change
- **AND** subsequent image and streaming updates follow the latest output as requested

### Requirement: Snapshot transport and serving preserve conversation authority
Conversation snapshots and events SHALL carry opaque visual references and
availability, not captured image bytes. Serving previews or original SVG
source SHALL require the workspace conversation credential and issued
identifiers, with no filesystem interpretation of client input. Visual
enrichment SHALL preserve native replay ordering and cursor semantics.

#### Scenario: A client requests stored visual bytes
- **WHEN** a preview or source request lacks the required credential or names an unissued identifier
- **THEN** it is refused without exposing filesystem content

#### Scenario: A reconnect replays visual-bearing events
- **WHEN** a client reconnects behind the current conversation snapshot
- **THEN** replay does not duplicate already-applied text or recapture terminal visuals
- **AND** the client can recover newly available references through the existing resync protocol

#### Scenario: Completed and live Claude turns appear in paged history
- **WHEN** history is loaded while a newer Claude turn is running
- **THEN** visuals in completed turns are terminal independently of the current conversation status
- **AND** text-block completion does not finalize visuals in the still-running turn, even when that turn spans cursor pages

#### Scenario: A shorthand image reference completes before a long-running tool
- **WHEN** a supported shorthand reference closes during the streaming enrichment cadence
- **THEN** its terminated reference definition can be captured without waiting for later assistant text or turn completion

### Requirement: Managed agents receive scoped presentation guidance
Managed Claude Code and OpenCode sessions SHALL attempt to add native presentation
guidance describing supported embeds, limits, immutable capture, and resource
restrictions. Injection SHALL preserve existing prompts, instructions, and
permissions; it SHALL NOT edit repository or global configuration. Guidance
SHALL apply to resumed sessions as well as new ones.
Presentation hints are optional: an injection failure SHALL NOT prevent native
OpenCode startup or replace inherited configuration. Uatu SHALL log a sanitized
reason and let OpenCode apply its own configuration validation.

#### Scenario: Claude starts or resumes a session
- **WHEN** Uatu starts a new or resumed Claude Code session
- **THEN** native additional context describes how to share visuals without replacing the session's system prompt

#### Scenario: OpenCode starts with existing inline configuration
- **WHEN** Uatu starts a managed OpenCode 1.x or 2.x server with valid inline configuration
- **THEN** visual guidance is added only to that child process's native instructions
- **AND** existing configuration and instruction entries are preserved

#### Scenario: OpenCode guidance is disposed
- **WHEN** the owning OpenCode service is disposed
- **THEN** its private instruction file is removed without deleting another service's guidance

#### Scenario: Existing inline configuration is malformed
- **WHEN** Uatu cannot safely merge the inherited inline configuration
- **THEN** it logs a sanitized warning, preserves the inherited value verbatim, and starts OpenCode without optional Uatu hints

#### Scenario: Guidance state cannot be written
- **WHEN** the private guidance file cannot be prepared
- **THEN** OpenCode starts without optional Uatu hints and existing prompts, instructions, and permissions remain unchanged

#### Scenario: A crashed service left guidance files
- **WHEN** startup finds a guidance directory with a valid app ownership record and an owner PID proven absent
- **THEN** bounded housekeeping removes only that stale directory's app-owned instruction files
- **AND** live owners, unknown ownership, PID reuse, symlinks, and unrelated files are preserved
