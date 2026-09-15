## MODIFIED Requirements

### Requirement: Chat presents turns as readable conversation with inspectable activity
The web Chat surface SHALL render user prompts and streamed assistant Markdown as the primary conversation, with safe code rendering consistent with UatuCode's existing rendering posture. Reasoning, tool calls, command execution, file changes, and tool results SHALL be represented as subordinate, inspectable activity with running, completed, failed, and cancelled states rather than flattened into assistant prose. Every activity row SHALL name what it acted on where the agent reported it, including a shell command's command line, a file operation's path, and a search's pattern, so a row and any group summary it joins are legible without being opened. While a tool or command runs, its output SHALL be shown as it streams rather than only on completion, and its elapsed time SHALL be shown where the agent reports progress without output, so long-running activity shows progress. A finished non-shell tool's output SHALL retain its summary and bounded preview with a way to see the rest. Shell tools and normalized command items SHALL instead present a summary and one bounded-height scrollback viewport containing all available provider-supplied output, while running and after completion. Earlier shell output SHALL be reachable by scrolling rather than a separate preview or "Show more lines" disclosure. A command that completes before the surface renders a running update MUST still retain inspectable output and its provider-reported completion or failure state. Untrusted Markdown, tool output, filenames, and errors MUST NOT create active markup or script execution.

While a turn is running, the trailing run of activity SHALL be collapsed behind a single working line rather than rendered as flat rows. The line SHALL carry a live indicator, the elapsed time of the turn, and the step currently in flight, and SHALL be present from the moment the prompt is accepted, before any step has arrived, so the same line carries the turn from waiting to done. Opening the working line SHALL reveal its member rows with their live state, and a running member with output SHALL still open itself so its output viewport is visible. Shell output SHALL initially follow the bottom and respect subsequent reader scrolling. A working line the reader opened SHALL remain open when the turn finishes and the line settles into the finished group summary. Popping out or resizing shell output SHALL count as the reader opening both the output and its containing activity group. That output and group SHALL remain open on completion or failure. A group line SHALL carry a status indicator, live while its turn runs, neutral when every member finished cleanly, and failed when any member failed. A failed outcome MUST NOT rely on colour alone. The line SHALL also state in words that a step failed, in text that is visible and part of the line's accessible name, without the group being opened. The live indicator's motion SHALL honour the reader's reduced-motion preference.

#### Scenario: Assistant answer remains visually primary
- **WHEN** a turn contains assistant text interleaved with multiple tool calls
- **THEN** the answer reads as a coherent conversation
- **AND** tool activity can be expanded for detail without being mistaken for assistant prose

#### Scenario: A shell tool row names its command
- **WHEN** an agent runs a shell command through a tool that carries the command in its input
- **THEN** the row's subject is the command line
- **AND** a group that collapses several such rows still names the commands it contains

#### Scenario: Streaming tool lifecycle updates in place
- **WHEN** a tool moves from running to completed or failed
- **THEN** its existing activity entry updates state instead of adding a duplicate entry

#### Scenario: A running tool shows its output as it streams
- **WHEN** a tool is running and the agent streams its output
- **THEN** the surface shows that output as it arrives
- **AND** it updates the tool's existing entry in place

#### Scenario: A running tool without output shows elapsed time
- **WHEN** a tool has run for several seconds and the agent reports progress but no output
- **THEN** the row states the elapsed time
- **AND** the time updates in place

#### Scenario: A running shell command shows its output as it streams
- **WHEN** the agent reports rolling output for a running shell command
- **THEN** the command entry makes that output available without waiting for completion
- **AND** later output updates the same scrollback viewport, following the latest output only while its independent follow state is active

#### Scenario: A fast command retains its completed output
- **WHEN** a shell command completes before the client observes a running update
- **THEN** its completed output remains inspectable from the command entry
- **AND** the entry reports the provider's completed or failed outcome

#### Scenario: A finished tool's output is bounded with a way to see the rest
- **WHEN** a completed non-shell tool produced more output than the bounded preview shows
- **THEN** the entry shows a summary and a bounded preview
- **AND** offers a way to see the full output
- **AND** does not render the whole output by default

#### Scenario: A finished command's output is bounded with a way to see the rest
- **WHEN** a completed shell command produced more output than fits in its bounded-height viewport
- **THEN** the command entry retains one scrollback viewport
- **AND** all available provider-supplied output is reachable by scrolling without a separate preview or "Show more lines" disclosure

#### Scenario: Hostile content remains inert
- **WHEN** assistant Markdown or tool output contains script-capable markup or a JavaScript URL
- **THEN** the rendered conversation does not execute it or expose an active unsafe link

#### Scenario: The live tail collapses behind a working line
- **WHEN** a turn is running and the agent has produced several activity steps with no assistant text after them
- **THEN** those steps are not shown as flat rows
- **AND** one working line shows a live indicator, the turn's elapsed time, and the step in flight

#### Scenario: The working line stands in for the waiting state
- **WHEN** a prompt has been accepted and nothing has come back yet
- **THEN** the working line is already present with its live indicator and elapsed time
- **AND** the first step to arrive joins it rather than replacing it with a different element

#### Scenario: Opening the working line reveals live steps
- **WHEN** the reader opens the working line while the turn runs
- **THEN** the member rows are shown with their running, completed, or failed state
- **AND** a running member with streamed output is open so its output is visible

#### Scenario: An opened working line stays open when the turn finishes
- **WHEN** the reader opened the working line and the turn then completes
- **THEN** the line becomes the finished group summary naming its steps
- **AND** it remains open

#### Scenario: A finished group signals a failed step
- **WHEN** a finished group contains a step that failed
- **THEN** the group line's status indicator reads as failed without the group being opened
- **AND** the line states in words that a step failed, so the outcome is carried by something other than colour alone

#### Scenario: Reduced motion stills the live indicator
- **WHEN** the reader's system prefers reduced motion
- **THEN** the working line's live indicator does not animate

#### Scenario: Reader-sized output stays open when work finishes
- **WHEN** the reader resizes or pops out shell output and the command or containing turn then completes or fails
- **THEN** the output and its containing activity group remain reader-opened
- **AND** popped-out output remains open on the same item until the reader returns it inline, opens another item, switches conversations, closes its owning child transcript, or the item is removed or its view is disposed
- **AND** the provider-reported outcome remains visible without resetting the reading state

### Requirement: Shell output reads as the terminal would render it
Where a tool's output carries terminal escape sequences, Chat SHALL interpret them rather than show them. Select-graphic-rendition styling, including the 16 standard colours, 256-colour and truecolour foreground and background, bold, dim, italic, underline, inverse, and strikethrough, SHALL be rendered as styling. Carriage-return overwrites and erase-line sequences SHALL be applied so a line that was rewritten in place shows only its final content, and any other control sequence SHALL be removed from the shown text. Interpreting escapes MUST NOT create active markup or script execution, whatever the sequences or the text around them contain.

A shell command's output block SHALL be presented with the embedded terminal's background, foreground, 16-colour palette, and font, so the same bytes read the same in Chat and in the terminal pane. The palette SHALL be the one central set of terminal colour variables, not a second copy. Lines in a shell output block SHALL NOT be broken mid-token. A line longer than the block SHALL scroll horizontally, as it would in the terminal.

Shell scrollback SHALL operate on the lines as rendered after overwrites are applied, so a progress bar that rewrote one line many times counts as one line, not as many. The viewport SHALL retain all available provider-supplied output for the item during its retained view lifetime, without a client-side preview or tail limit discarding earlier output. This contract SHALL apply to shell tools and normalized command items in both parent and subagent conversations, while running and after completion or failure. It SHALL NOT require recovery of output truncated upstream by the provider. Non-shell output SHALL retain its existing preview behavior.

#### Scenario: Coloured test output renders in colour
- **WHEN** a shell command's output contains `\x1b[32mpass\x1b[0m` and `\x1b[31mfail\x1b[0m`
- **THEN** the block shows "pass" in the terminal's green and "fail" in the terminal's red
- **AND** no bracket-code fragments appear in the text

#### Scenario: A progress bar collapses to its final state
- **WHEN** a running command rewrites one line repeatedly with carriage returns and erase-line sequences
- **THEN** the block shows that line once, with its latest content
- **AND** the scrollback's line count treats it as one line

#### Scenario: Unknown control sequences are dropped
- **WHEN** a command's output contains cursor-movement or operating-system-command sequences the renderer does not interpret
- **THEN** those sequences do not appear in the shown text
- **AND** the surrounding text is shown intact

#### Scenario: Escapes cannot smuggle markup
- **WHEN** a command's output interleaves escape sequences with `<script>` text or a JavaScript URL
- **THEN** the rendered block contains no active markup and executes nothing

#### Scenario: Shell output uses the terminal's palette and font
- **WHEN** the same coloured output is shown in Chat and typed into the embedded terminal
- **THEN** both use the same background, foreground, colour values and font family
- **AND** changing a terminal colour variable changes both

#### Scenario: Long lines scroll instead of wrapping
- **WHEN** a command prints a table wider than the output block
- **THEN** the columns stay aligned and the block scrolls horizontally
- **AND** no line is broken mid-token

#### Scenario: Earlier output remains available throughout the command lifecycle
- **WHEN** a shell tool or normalized command item in a parent or subagent conversation emits more rendered lines than fit in the viewport
- **THEN** the reader can scroll to the earliest available provider-supplied lines while it runs and after it completes or fails
- **AND** later output does not discard earlier available lines to maintain a preview or tail limit

#### Scenario: Provider truncation does not imply recoverable output
- **WHEN** the provider supplies only a truncated portion of a command's output
- **THEN** scrollback makes that available portion inspectable
- **AND** Chat does not claim that omitted upstream output can be recovered by its scrollback controls

### Requirement: Timeline position remains stable under streaming and navigation
The Chat timeline SHALL remain pinned to the latest content only while the user is at or near its end. Once the user scrolls away, streaming, tool updates, image or code layout, and activity expansion MUST NOT steal the reading position; an accessible latest-content affordance SHALL indicate unseen updates and return to the end. Prepending older history SHALL preserve the same visible content and offset. Opening a conversation SHALL restore that client's last reading position when possible, otherwise it SHALL open at the latest turn.

Each shell viewport SHALL have a follow state independent of the outer timeline and other shell items. It SHALL initially follow the bottom. Any upward reader scroll SHALL stop following, including a movement smaller than a near-bottom threshold. Returning to the bottom or activating the viewport's accessible latest-output control SHALL resume following. Incoming output while following SHALL keep the bottom visible without resetting the horizontal offset. While following is paused, incoming output SHALL preserve the visible rendered content and its vertical offset, and the latest-output control SHALL indicate unseen output.

Output updates, layout resize, inline height adjustment, Pop out, Maximize, Restore size, Return to chat, changes between desktop and touch presentation, and completion or failure SHALL preserve the shell item's horizontal position, vertical reading anchor, chosen inline height, and follow state. Position and applied size SHALL be clamped only where the available content or layout cannot accommodate them. A layout change that clamps position to the bottom MUST NOT itself resume paused following. Resizing or popping out shell output SHALL preserve the outer timeline's reading anchor, and returning inline SHALL preserve its current reading anchor, including any deliberate outer scrolling while the nonmodal window was open. Shell scrolling and its latest-output control MUST NOT independently move the outer timeline to its end. Long shell output SHALL preserve long-chat responsiveness, text selection, copying, and find over available rendered output.

Following SHALL be stable in both parent and child outer timelines and in each shell output viewport, whether inline or popped out. While following during passive append-only updates, automatic movement MUST NOT alternate upward and downward when the scroll extent is not shrinking. Activating the relevant latest-content or latest-output control during streaming SHALL settle at the current bottom and continue following without oscillation between smooth movement and snapping. Any upward manual scroll SHALL interrupt automatic movement immediately and pause following, even during movement initiated by a latest control. Resize effects and programmatic scroll echoes MUST NOT change the reader's follow intent. A shrinking layout or content extent MAY cause a legitimate position clamp without being treated as follow jitter or resuming paused following.

#### Scenario: Active reader follows streaming output
- **WHEN** the user is at the end of the timeline as assistant content streams
- **THEN** new content remains visible without repeated manual scrolling

#### Scenario: Reading older content is not interrupted
- **WHEN** the user scrolls above the end while content continues streaming
- **THEN** their visible content remains anchored
- **AND** an affordance reports and navigates to unseen latest content

#### Scenario: Any upward scroll leaves the end
- **WHEN** the user scrolls upward by less than the near-end distance while content continues streaming
- **THEN** the timeline is no longer pinned and the next update does not return it to the end

#### Scenario: Sending returns the reader to the end
- **WHEN** the user submits a message while scrolled above the end
- **THEN** the timeline moves to the end so the sent message and the reply that follows are in view

#### Scenario: Loading older history preserves the viewport
- **WHEN** the user requests an older history page at the top of the loaded timeline
- **THEN** the previously visible first item remains at the same visual offset after insertion

#### Scenario: Expanding activity does not cause an unrelated jump
- **WHEN** the user expands or collapses a tool entry away from the timeline end
- **THEN** the chosen entry remains anchored in the viewport

#### Scenario: Shell output initially follows independently
- **WHEN** a shell viewport first shows output and further output arrives
- **THEN** it shows the bottom of its scrollback
- **AND** an outer timeline scrolled away from its end retains its reading anchor

#### Scenario: Any upward shell scroll pauses following
- **WHEN** the reader scrolls a shell viewport upward even by less than a near-bottom threshold and more output arrives
- **THEN** the viewport preserves the reader's visible content and vertical offset instead of returning to the bottom
- **AND** its latest-output control indicates unseen output
- **AND** other shell viewports and the outer timeline retain their own follow state

#### Scenario: Returning to latest output resumes following
- **WHEN** the reader scrolls a paused shell viewport back to the bottom or activates its latest-output control
- **THEN** that viewport resumes following incoming output
- **AND** it preserves its horizontal offset and does not jump the outer timeline to its end

#### Scenario: Reading position survives output and layout changes
- **WHEN** the reader has paused shell following and scrolled horizontally, and the output updates, the layout resizes, the inline height changes, the viewport is popped out, maximized, restored to floating size, returned inline, changes between desktop and touch presentation, or the command completes or fails
- **THEN** the same rendered content remains at the same vertical offset and the horizontal offset is preserved wherever the content and layout permit
- **AND** the chosen inline height is retained with its applied size clamped to the available layout
- **AND** following remains paused even if clamping places the viewport at the bottom

#### Scenario: Following survives resize and completion
- **WHEN** a shell viewport is following and is resized, popped out, maximized, restored to floating size, returned inline, changes between desktop and touch presentation, or receives completion or failure
- **THEN** it remains at the bottom with following active
- **AND** its horizontal offset and chosen inline height are retained within available bounds

#### Scenario: Long scrollback remains usable
- **WHEN** a long conversation contains shell output spanning many viewport heights and further output streams
- **THEN** scrolling, resizing, and conversation controls remain responsive
- **AND** available rendered output remains selectable, copyable, and reachable through find in inline, floating, maximized, and touch full-area views
- **AND** streaming does not clear an existing selection in unchanged output or steal the outer reading anchor

#### Scenario: Passive following does not jitter during append
- **WHEN** a parent outer timeline, child outer timeline, or shell output viewport is following during passive append-only streaming and its scroll extent is not shrinking
- **THEN** automatic scrolling keeps the latest content visible without alternating upward and downward movement
- **AND** the same behavior applies to inline, floating, maximized, and touch full-area shell output

#### Scenario: Latest settles at the bottom during streaming
- **WHEN** the reader activates the latest control in a parent outer timeline, child outer timeline, or shell output viewport while content continues appending
- **THEN** the view settles at the current bottom and follows subsequent appends
- **AND** it does not oscillate between smooth movement and snapping

#### Scenario: Manual upward scrolling interrupts automatic movement
- **WHEN** the reader scrolls upward in a parent outer timeline, child outer timeline, or shell output viewport during automatic following or movement initiated by its latest control
- **THEN** automatic movement stops immediately and following pauses, even for movement smaller than the near-bottom threshold
- **AND** subsequent appends preserve the reader's position rather than completing the interrupted movement

#### Scenario: Resize and programmatic echoes preserve follow intent
- **WHEN** resize effects or scroll events caused by automatic movement occur in a parent outer timeline, child outer timeline, or shell output viewport
- **THEN** they do not change whether the reader has chosen to follow
- **AND** a legitimate position clamp after layout or content shrink is allowed
- **AND** clamping a paused view to the bottom does not resume following

## ADDED Requirements

### Requirement: Shell scrollback has accessible inline sizing and a floating output window
Each shell tool and normalized command item's output in a parent or subagent conversation SHALL offer inline height adjustment through both pointer and keyboard controls. The resize control SHALL be focusable, have an accessible name, expose its current size and bounds, and show visible keyboard focus. Applied inline height SHALL be finite and clamped between a usable minimum and the available layout height. A layout smaller than the preferred minimum SHALL take precedence so output cannot force controls outside the available area. The reader's chosen inline height SHALL be retained while output is popped out and restored on return inline, subject to those bounds.

On desktop, an accessible Pop out control SHALL move the same output into one nonmodal in-app floating window. The reader SHALL be able to drag the window and resize its width and height, with keyboard equivalents for movement and both resize dimensions. Its bounds SHALL be the UatuCode work area, not the Chat column, panel, or transcript area. The window SHALL be able to exceed the Chat width while keeping its controls reachable within the work area. Uncovered parts of the app SHALL remain usable without dismissing the window. Pop out MUST NOT open a separate browser window or use browser fullscreen.

Maximize SHALL fill the UatuCode work area. Restore size SHALL return a maximized window to its previous floating position and dimensions, clamped only as needed to fit the current work area. In touch mode, Pop out SHALL present a full-area output view within the UatuCode work area instead of floating drag and resize interactions. Maximized and touch full-area output MAY cover Preview, the composer, and request controls, but controls to return to chat SHALL remain reachable. Covered app controls MUST NOT receive keyboard focus while covered.

Each Chat surface SHALL have at most one popped-out shell output across its parent and child transcripts. Popping out another item SHALL return the previous item inline with its reading state retained before opening the selected item. Return to chat and Escape from the output SHALL return it directly inline, including from maximized or touch full-area presentation. They SHALL restore focus to the invoking control when available or a logical control for the same item without stealing the current outer reading anchor. Escape handled by output MUST NOT also close the subagent transcript. Pop out SHALL place keyboard focus within the output controls. All controls SHALL have accessible names and visible focus, and keyboard movement and resize controls SHALL expose their current values and bounds.

#### Scenario: Inline output can be resized with a pointer or keyboard
- **WHEN** the reader adjusts a shell viewport using its pointer resize control or focuses the resize control and uses the keyboard
- **THEN** its inline height changes within the available bounds
- **AND** the control exposes the resulting size and bounds accessibly
- **AND** the reader retains the output's reading position and follow state

#### Scenario: Output height remains bounded in a smaller layout
- **WHEN** the reader requests an inline height beyond the available layout or the layout shrinks below the chosen inline height
- **THEN** the applied height remains finite and clamped to the available layout
- **AND** output controls, the composer, and request controls remain reachable
- **AND** the chosen height remains available when space permits it again

#### Scenario: Pop out opens beyond the chat column
- **WHEN** the reader pops out shell output from a parent or subagent transcript on desktop
- **THEN** the same output appears in a nonmodal in-app floating window whose width can exceed the Chat column or panel within the UatuCode work area
- **AND** keyboard focus moves into the output controls and Return to chat is available
- **AND** uncovered app content and controls remain usable
- **AND** no separate browser window or browser fullscreen opens

#### Scenario: Floating output can be moved and resized with a pointer or keyboard
- **WHEN** the reader drags or uses keyboard movement controls, or resizes either dimension with pointer or keyboard controls
- **THEN** the floating window changes position, width, or height within the UatuCode work area
- **AND** its controls remain reachable and keyboard controls expose current values and bounds
- **AND** the output retains its reading anchor, horizontal offset, and follow state within available bounds

#### Scenario: Maximize and Restore size preserve floating bounds
- **WHEN** the reader maximizes floating output and then activates Restore size
- **THEN** Maximize fills the UatuCode work area and may cover Preview and the composer while keeping Return to chat reachable
- **AND** Restore size returns to the previous floating position, width, and height, clamped only to fit the current work area
- **AND** neither action overwrites the chosen inline height or follow state

#### Scenario: Touch output uses a full-area view
- **WHEN** the reader pops out shell output in touch mode
- **THEN** the same output fills the UatuCode work area without floating drag or resize interactions
- **AND** Return to chat remains reachable even when Preview, the composer, or request controls are covered
- **AND** keyboard focus cannot move to covered app controls

#### Scenario: Only one shell view is popped out per Chat surface
- **WHEN** one shell view is popped out and the reader pops out a different item in the parent or a child transcript
- **THEN** the previous item returns inline with its reading state retained
- **AND** only the newly selected item owns the popped-out view

#### Scenario: Return to chat returns to the inline reading context
- **WHEN** the reader activates Return to chat or presses Escape from floating, maximized, or touch full-area shell output
- **THEN** the output returns inline at its retained height subject to available bounds
- **AND** focus returns to the invoking control or a logical control for that item if the invoking control is unavailable
- **AND** the outer timeline anchor and shell reading state are restored
- **AND** maximized output returns directly inline without an intermediate floating view

#### Scenario: Escape returns child output without closing the child
- **WHEN** shell output is popped out from a subagent transcript, including maximized or touch full-area output, and the reader presses Escape from that output
- **THEN** the shell output returns inline within that transcript
- **AND** the subagent transcript remains open

#### Scenario: Return respects reading elsewhere in the transcript
- **WHEN** the reader scrolls the uncovered outer transcript while a floating output window is open and then returns that output inline
- **THEN** the current outer reading position remains anchored rather than reverting to the position saved at Pop out
- **AND** focus restoration does not scroll the transcript back to an offscreen invoking control

### Requirement: Popped-out output identifies and retains its owning command
Popped-out output SHALL remain bound to the specific immutable conversation and item identity selected by the reader. It SHALL show the command, conversation label, and provider-reported running, completed, failed, or cancelled status. It SHALL show the provider's completion time when known and MUST NOT fabricate a completion time when unknown. Disconnection MUST NOT be presented as completion. Completion, failure, cancellation, activity regrouping, and later commands SHALL NOT dismiss the output or automatically switch it to another item. Output and status updates SHALL continue to apply only to its owning item.

#### Scenario: The window identifies the selected command
- **WHEN** the reader pops out a shell item from a parent or child conversation
- **THEN** the output shows that item's command, conversation label, and provider-reported status
- **AND** updates to other items do not change its conversation or item identity

#### Scenario: Completed output stays open as later commands run
- **WHEN** the selected command completes, fails, or is cancelled and later commands start or activity is regrouped
- **THEN** its output remains open with its own provider-reported outcome
- **AND** the window does not switch automatically to a later command
- **AND** its reading state is retained

#### Scenario: Completion metadata is not invented
- **WHEN** a provider reports command completion with a known completion time
- **THEN** the output shows that provider-reported time
- **AND** when the provider supplies no completion time, the output does not invent one

#### Scenario: Disconnection is not completion
- **WHEN** the provider disconnects without reporting a terminal outcome for the selected running command
- **THEN** the output does not label that command completed or fabricate a completion time

### Requirement: Shell reading state is local to its conversation and item
Shell reading state SHALL belong to the local client's immutable conversation and item identity during the retained view lifetime. It SHALL include the output's horizontal position, vertical reading anchor and offset, chosen inline height, follow state, reader-opened status, and floating position and dimensions. These values SHALL survive output updates, moves between inline and popped-out views, Maximize, Restore size, desktop/touch presentation changes, and command lifecycle changes, subject to available content and layout bounds. Temporary maximized or touch full-area geometry MUST NOT overwrite the retained floating bounds. Updates to other items or conversations MUST NOT overwrite this state. This contract SHALL NOT require persistence across reloads.

Explicitly switching the selected conversation SHALL close any popped-out shell output and release its old focus, movement, resize, and keyboard ownership so it cannot act on the new conversation. Leaving or closing a child transcript SHALL likewise release output owned by that child. Removing the owning item or disposing its view SHALL close its output and release those interactions. Popped-out output SHALL NOT remain pinned across conversations. Retained per-item reading state SHALL remain scoped to its owning conversation if it survives navigation, and returning SHALL NOT automatically reopen the prior popped-out view. A newly created view without retained state SHALL start with the default bounded inline height and bottom following.

Hiding Chat without changing the selected conversation SHALL hide its output window and defer output painting under the existing hidden-Chat behavior. Returning to the same retained Chat view SHALL restore the window's presentation and reconcile its owning item's latest output and status. It SHALL NOT display an independent output inspector over another active app tab.

#### Scenario: Switching conversations releases popped-out ownership
- **WHEN** the reader explicitly switches conversations while a parent or child shell output is popped out
- **THEN** the popped-out view closes and its old focus, movement, resize, and keyboard ownership is released
- **AND** subsequent input affects only the current conversation
- **AND** no old shell reading state is applied to an item in the new conversation

#### Scenario: Leaving a child transcript releases its popped-out view
- **WHEN** the reader navigates out of or closes a child transcript that owns popped-out shell output
- **THEN** that popped-out view closes and releases its interaction ownership
- **AND** the parent transcript remains usable with its own reading state

#### Scenario: Retained reading state survives a return without reopening output
- **WHEN** the reader returns to a conversation whose shell item view state was retained
- **THEN** the item uses its retained position, inline height, follow state, and reader-opened status within current bounds
- **AND** its previous popped-out view does not reopen automatically
- **AND** a later explicit Pop out uses its retained floating bounds within the current work area

#### Scenario: Presentation changes preserve per-item geometry and reading state
- **WHEN** the reader moves an item between inline, floating, maximized, and touch full-area output and then returns to floating or inline output
- **THEN** floating output uses its retained floating position and dimensions and inline output uses its chosen inline height, subject to current layout bounds
- **AND** the output retains its horizontal offset, vertical reading anchor, and follow state wherever the content and layout permit
- **AND** maximized or touch full-area dimensions do not replace its retained floating geometry

#### Scenario: Item removal or view disposal releases output interactions
- **WHEN** the owning item is removed or its view is disposed while output is popped out
- **THEN** the popped-out view closes and releases its focus, movement, resize, and keyboard ownership
- **AND** subsequent pointer or keyboard input cannot manipulate the removed output or an unrelated item

#### Scenario: A fresh view does not require persisted reading state
- **WHEN** a shell item is opened after reload or after its retained view state has been released
- **THEN** it can start at the default bounded inline height with bottom following
- **AND** restoring prior local shell reading state from persistent storage is not required

#### Scenario: Hiding Chat hides its output window
- **WHEN** the reader hides Chat or selects another app tab without changing the selected conversation
- **THEN** its output window is hidden and output painting is deferred
- **AND** returning to the same retained Chat view restores the output window with its owning item's latest output and status
