# Spec Delta

## Purpose

Lets readers inspect fine detail in images, SVGs and diagrams on desktop and
touch, by zooming and panning media inline within its own box or in one
shared fullscreen viewer, consistently across file previews, rendered
documents and chat.

## ADDED Requirements

### Requirement: Supported media is zoomable on every surface
Uatu SHALL offer zoom and pan for raster image file previews, SVG file previews, images embedded in rendered Markdown and AsciiDoc, rendered Mermaid diagrams, chat assistant visuals, and chat attachment images. Each such media SHALL offer the shared fullscreen viewer and, subject to the small-media rule, inline zoom, except that attachment thumbnails offer only the viewer and an image sharing its link with other content neither. Video, audio, PDF and terminal content MUST NOT gain zoom controls.

#### Scenario: Each surface offers zoom
- **WHEN** a raster image file, an SVG file, a document with an embedded image, a document with a Mermaid diagram, or an assistant reply with a visual is shown, the media rendered at least 96 CSS pixels on both sides and, if it is linked, the only content of its link
- **THEN** that media offers inline zoom and can be opened in the fullscreen viewer

#### Scenario: An attached image opens the viewer
- **WHEN** a message with an attached image is shown
- **THEN** its thumbnail can be opened in the fullscreen viewer
- **AND** it offers no inline zoom

#### Scenario: Out-of-scope media is unchanged
- **WHEN** a video, audio file or PDF is previewed, or the terminal is shown
- **THEN** no zoom control or zoom gesture is added to it

### Requirement: Small media opens the viewer without inline zoom
Media rendered smaller than 96 CSS pixels in width or height, such as badges, icons and thumbnails, SHALL NOT offer inline zoom. Activating it SHALL open the fullscreen viewer.

#### Scenario: A badge opens the viewer
- **WHEN** a document image renders at 80×20 CSS pixels and the user hovers or focuses it
- **THEN** no inline zoom toolbar appears
- **AND** clicking or tapping it opens the fullscreen viewer at fit

#### Scenario: A chat attachment thumbnail opens the viewer
- **WHEN** an attachment thumbnail renders below 96 CSS pixels and the user activates it
- **THEN** the fullscreen viewer opens showing the attachment at fit

### Requirement: Chat attachment thumbnails open the viewer without inline zoom
A chat attachment thumbnail, in a sent message, the queue or the composer, is a preview of a larger image, so it SHALL NOT offer inline zoom at any rendered size, including 96 CSS pixels or more on both sides. Wheel, trackpad pinch and touch pinch input on it MUST NOT zoom it inline. Activating it by click, tap, Enter or Space SHALL open the fullscreen viewer showing the full image at fit.

#### Scenario: A large thumbnail opens the viewer
- **WHEN** an attachment thumbnail renders at 96 CSS pixels or more on both sides and the user hovers it, scrolls the wheel or pinches on it
- **THEN** no inline zoom toolbar appears and the thumbnail is not zoomed inline
- **AND** clicking, tapping or pressing Enter on it opens the fullscreen viewer showing the full image at fit

### Requirement: Inline zoom stays within the media's box
Inline zoom SHALL scale and pan the media inside the box it occupies at fit, clipping anything outside that box. Zooming or panning inline MUST NOT change the size or position of the box or of any surrounding content. Inline zoom SHALL range from fit up to the viewer's maximum scale, and panning SHALL keep the zoomed media covering its box.

#### Scenario: Zooming inline causes no layout shift
- **WHEN** the user zooms a document image inline from fit to 3×
- **THEN** the image's box keeps its size and position
- **AND** the text above and below the image does not move
- **AND** the zoomed image is clipped to its box

#### Scenario: Inline zoom cannot shrink below fit
- **WHEN** inline media is at fit and the user activates zoom out
- **THEN** the media stays at fit

#### Scenario: Inline panning stops at the media's edges
- **WHEN** the user drags zoomed inline media past one of its edges
- **THEN** the media stops with that edge aligned to the box
- **AND** no empty area appears inside the box

#### Scenario: An image's margins stay outside its box
- **WHEN** a document image with space around it (`hspace`) is zoomed inline and panned to one of its edges
- **THEN** the zoomed image covers the box the image itself had at fit, with no blank strip where its margin was
- **AND** the image's margins and the text around it do not move

### Requirement: Desktop inline zoom uses an overlay toolbar and drag
On desktop, zoomable inline media SHALL show an overlay toolbar with zoom in, zoom out, fit and expand controls while the pointer hovers the media or keyboard focus is within it. Once the media is zoomed past fit, dragging it SHALL pan it. The expand control SHALL open the fullscreen viewer.

#### Scenario: The toolbar appears on hover and focus
- **WHEN** the pointer hovers a zoomable inline image, or keyboard focus moves onto it or its toolbar
- **THEN** the zoom in, zoom out, fit and expand controls are visible
- **AND** each control has an accessible name

#### Scenario: Toolbar zoom and drag pan the media
- **WHEN** the user activates zoom in twice on an inline diagram and then drags the diagram
- **THEN** the diagram is shown larger within its box and moves with the pointer
- **AND** activating fit returns it to fit

#### Scenario: Expand opens the viewer
- **WHEN** the user activates expand on inline media
- **THEN** the fullscreen viewer opens with that media at fit

### Requirement: Inline controls never hide narrow media
Zoomable media narrower than 200 CSS pixels SHALL show its inline toolbar outside its box, above it or, where the space above is out of view, below it, both at fit and zoomed. That toolbar MUST NOT cover the media and SHALL stay within the visible area. Wider media SHALL show the toolbar over its top-right corner.

#### Scenario: A narrow diagram shows its toolbar above it
- **WHEN** the pointer hovers a rendered Mermaid diagram 134 CSS pixels wide, at fit or zoomed
- **THEN** its zoom in, zoom out, fit and expand controls are shown just above the diagram
- **AND** no control covers any part of the diagram

#### Scenario: Narrow media at the top of the view shows its toolbar below it
- **WHEN** narrow media sits just below the top of the visible area, such as under the preview's sticky header, and the pointer hovers it
- **THEN** its toolbar is shown just below the media, inside the visible area

### Requirement: Each zoom action has one icon everywhere
The inline toolbar and the viewer toolbar SHALL show the same icon for the same action, and fit and expand SHALL have clearly different icons. Every control SHALL keep its accessible name, and the icons MUST add no text that Find can match.

#### Scenario: Fit looks the same inline and in the viewer
- **WHEN** the user compares the inline toolbar with the viewer toolbar
- **THEN** fit has the same icon in both
- **AND** expand, inline, has an icon different from fit

### Requirement: Zoom controls show their limits and the level
Zoom in and zoom out SHALL be marked unavailable, while staying focusable, at the maximum and the minimum zoom; inline, zoom out is unavailable at fit. The viewer toolbar SHALL show the zoom level as a percentage of fit, where 100% is the media fitted. A level set by a toolbar control or a key SHALL be announced through a polite status region, and a pinch, a wheel or a drag MUST NOT announce.

#### Scenario: The viewer shows the level relative to fit
- **WHEN** the viewer opens at fit and the user activates zoom in once
- **THEN** the toolbar shows 100% and then 125%
- **AND** "Zoom 125%" is announced politely

#### Scenario: Controls at a limit are unavailable but focusable
- **WHEN** inline media is at fit, or zoomed media reaches the maximum scale
- **THEN** zoom out, or zoom in, is announced as unavailable and keeps keyboard focus when it has it

#### Scenario: A gesture announces nothing
- **WHEN** the user pinches or scrolls the wheel in the viewer
- **THEN** the level shown follows the zoom
- **AND** no level is announced

### Requirement: The wheel never zooms inline media
Inline media MUST NOT respond to wheel input, including the wheel events a trackpad pinch produces. Wheel input over inline media SHALL keep its default effect, so scrolling continues to scroll the surrounding surface. Wheel and trackpad pinch zoom SHALL be available in the fullscreen viewer.

#### Scenario: Scrolling over an image scrolls the document
- **WHEN** the user scrolls the mouse wheel with the pointer over an inline image, at fit or zoomed
- **THEN** the document scrolls as it would over text
- **AND** the image's zoom is unchanged

#### Scenario: A trackpad pinch over inline media does not zoom it
- **WHEN** the user pinches on a trackpad with the pointer over inline media
- **THEN** the inline media's zoom is unchanged

### Requirement: Touch inline zoom uses pinch and one-finger pan
On touch, a two-finger pinch on zoomable inline media SHALL zoom that media, anchored on the midpoint between the fingers, and MUST NOT zoom the page. At fit, a one-finger drag on the media SHALL scroll the page. Once the media is zoomed past fit, a one-finger drag SHALL pan the media, and the fit and expand controls SHALL be shown. A drag that reaches the media's top or bottom edge SHALL scroll the page with the rest of its movement.

#### Scenario: Pinching media zooms the media, not the page
- **WHEN** the user pinches outward with two fingers on an inline image
- **THEN** the image zooms within its box
- **AND** the page's own zoom level and layout are unchanged

#### Scenario: One finger scrolls the page at fit
- **WHEN** inline media is at fit and the user drags one finger vertically across it
- **THEN** the page scrolls
- **AND** the media's zoom and pan are unchanged

#### Scenario: One finger pans zoomed media
- **WHEN** inline media is zoomed past fit and the user drags one finger across it, within the media's edges
- **THEN** the media pans within its box
- **AND** the page does not scroll

#### Scenario: A pan past the media's edge scrolls the page
- **WHEN** inline media is zoomed past fit and the user drags one finger up further than the media extends below its box
- **THEN** the media stops with its bottom edge aligned to the box
- **AND** the page scrolls by the rest of the finger's movement

#### Scenario: Zoomed media shows fit and expand controls
- **WHEN** inline media on touch is zoomed past fit
- **THEN** fit and expand controls are shown on it
- **AND** activating fit returns the media to fit and hides them

### Requirement: Activating media at fit opens the viewer
A click or tap on zoomable media at fit SHALL open the fullscreen viewer. While media is zoomed inline, a click, tap or drag on it SHALL only pan it, and pointer input SHALL open the viewer only through the expand control; Enter or Space on the media still opens it. Media at fit SHALL indicate that it opens the viewer, for example with a zoom-in cursor.

#### Scenario: A click at fit opens the viewer
- **WHEN** the user clicks or taps inline media at fit
- **THEN** the fullscreen viewer opens showing that media at fit

#### Scenario: A click on zoomed media does not open the viewer
- **WHEN** inline media is zoomed past fit and the user clicks, taps or drags it
- **THEN** the viewer does not open
- **AND** a drag pans the media

### Requirement: Linked images open the viewer with an Open link action
An image that is the only content of a link, apart from whitespace, SHALL open the fullscreen viewer when activated, like any other media, instead of following the link. The viewer SHALL then offer an "Open link" action that follows the link under the preview's normal link rules: a link to a watched document opens it in the app, and other links behave as they do when clicked in the preview.

#### Scenario: Clicking a linked image opens the viewer
- **WHEN** a document contains an image wrapped in a link and the user clicks the image at fit
- **THEN** the fullscreen viewer opens showing the image
- **AND** the link is not followed

#### Scenario: Open link follows an in-app document link
- **WHEN** the viewer shows a linked image whose link targets another watched document and the user activates "Open link"
- **THEN** the viewer closes and the preview shows the linked document

#### Scenario: Open link follows an external link
- **WHEN** the viewer shows a linked image whose link targets an external URL and the user activates "Open link"
- **THEN** the link is followed exactly as clicking it in the preview would follow it

#### Scenario: Unlinked media has no Open link action
- **WHEN** the viewer shows media that is not inside a link
- **THEN** no "Open link" action is shown

### Requirement: An image sharing its link with other content stays a plain link
An image inside a link that also holds other content, such as text other than whitespace, a caption or another element, SHALL stay part of a plain link. It SHALL offer no inline zoom and no viewer, and activating it SHALL follow the link under the preview's normal link rules.

#### Scenario: A captioned linked image follows its link
- **WHEN** a document contains a link holding an image and caption text, and the user clicks the image
- **THEN** the link is followed under the preview's normal link rules
- **AND** the image shows no inline zoom controls and the viewer does not open

### Requirement: Zoomable media is keyboard operable
Each zoomable media SHALL be reachable by keyboard as one interactive element with an accessible name, and Enter or Space on it SHALL open the fullscreen viewer. Its inline zoom controls SHALL be separate focusable controls, not nested inside another interactive element. A rendered Mermaid diagram SHALL keep the accessible name "Open diagram in fullscreen viewer". Arrow keys on focused media zoomed inline SHALL pan it without scrolling the page; at fit they keep their default.

#### Scenario: A rendered diagram is focusable and opens with Enter or Space
- **WHEN** a user tabs through the preview to a rendered Mermaid diagram
- **THEN** the diagram receives focus as a single interactive element announced as a button named "Open diagram in fullscreen viewer"
- **AND** pressing Enter or Space opens the fullscreen viewer

#### Scenario: Inline controls are reachable by keyboard
- **WHEN** keyboard focus is on zoomable inline media and the user presses Tab
- **THEN** focus moves through the visible inline zoom controls
- **AND** no control is nested inside another button or link

#### Scenario: Arrow keys pan zoomed inline media
- **WHEN** keyboard focus is on inline media zoomed past fit and the user presses an arrow key
- **THEN** the media pans to show more of it in that direction
- **AND** the page does not scroll
- **AND** at fit the same key scrolls the page as usual

#### Scenario: A linked image without a name still has one
- **WHEN** a document contains a link whose only content is an image with empty alt text, and neither has any other name
- **THEN** the link is announced with a name saying that it opens the image in the fullscreen viewer
- **AND** a name the author gave the link or the image is kept unchanged

### Requirement: Image activators say what they open
An image, a responsive image or a linked image that activates the viewer SHALL keep its alt text or authored name as its accessible name and SHALL carry the description "Opens in the fullscreen viewer". Each inline toolbar group SHALL be named after its media, as "Zoom controls for" followed by the media's alt text, or "diagram" for a Mermaid diagram.

#### Scenario: An image says that it opens the viewer
- **WHEN** a screen reader reaches a document image with the alt text "figure"
- **THEN** it is announced as a button named "figure", described as "Opens in the fullscreen viewer"
- **AND** its toolbar is a group named "Zoom controls for figure"

#### Scenario: A diagram's names are kept
- **WHEN** a screen reader reaches a rendered Mermaid diagram
- **THEN** it is announced as "Open diagram in fullscreen viewer", with no further description
- **AND** its toolbar is a group named "Zoom controls for diagram"

### Requirement: One shared fullscreen viewer serves every surface
A single fullscreen viewer SHALL present media from every zoomable surface. It SHALL always open at fit, showing the media's real content rather than any placeholder used for deferred loading. It SHALL fill the visible viewport, keep its controls inside it and clear of device safe areas in every orientation, and present targets of at least 44px on coarse-pointer devices. Closing it SHALL leave inline zoom unchanged.

#### Scenario: The viewer fills the visible viewport
- **WHEN** the viewer opens
- **THEN** it occupies the full window width and the full visible height, even when the nominal viewport is taller than the visible area
- **AND** the rest of the page is visually backgrounded behind it

#### Scenario: The viewer opens at fit
- **WHEN** the user opens the viewer from media that is zoomed inline
- **THEN** the viewer shows the media scaled to fit and centered

#### Scenario: Off-screen SVG opens with its real content
- **WHEN** the user opens the viewer for a document SVG whose inline image is currently suspended because it is off-screen
- **THEN** the viewer shows the SVG's actual content

#### Scenario: A viewer opened straight after closing shows its media
- **WHEN** the viewer closes and media is activated again before the page has handled anything else, such as by the click a closing tap ends in
- **THEN** the viewer opens showing that media at fit

#### Scenario: Closing the viewer keeps inline zoom
- **WHEN** the user zooms inline media to 2×, opens the viewer through expand, zooms there, and closes the viewer
- **THEN** the inline media is still at 2× with the same pan

#### Scenario: Controls are reachable on touch devices
- **WHEN** the viewer is open on a touch device, in either orientation, in a browser tab or an installed PWA
- **THEN** every viewer control, including close, is within the visible viewport and clear of browser chrome and safe areas
- **AND** each control is at least 44px on a coarse pointer

### Requirement: The viewer supports pointer, touch, toolbar and keyboard navigation
The viewer SHALL support single-pointer drag-to-pan, cursor-anchored wheel and trackpad-pinch zoom, midpoint-anchored two-finger pinch, double-click and double-tap anywhere in it to fit, a toolbar with zoom in, zoom out, fit and close, the `+`, `-`, `0` and `f` keys, and arrow keys to pan, Shift with an arrow by a larger step. Panning SHALL keep at least 96 CSS pixels of the media in view on each axis, and zoom SHALL be clamped to a bounded range.

#### Scenario: Wheel zoom centers on the cursor
- **WHEN** the viewer is open and the user scrolls the wheel over the media
- **THEN** the media zooms in or out
- **AND** the point under the cursor stays under the cursor

#### Scenario: Pinch zoom anchors on the midpoint between two fingers
- **WHEN** the viewer is open and the user moves two fingers apart or together on the media
- **THEN** the media zooms with the change in finger separation
- **AND** the media point beneath the midpoint of the fingers stays beneath it
- **AND** the surrounding page is not zoomed

#### Scenario: Drag pans the media
- **WHEN** the viewer is open and the user presses on the media and drags
- **THEN** the media moves with the pointer
- **AND** releasing the pointer ends the pan

#### Scenario: A second finger does not disturb an in-progress pan
- **WHEN** the user is panning with one finger and a second finger touches the surface, or lifts again afterwards
- **THEN** the media does not jump at either transition
- **AND** panning resumes from the position of the finger that remains

#### Scenario: Panning cannot move the media entirely off-screen
- **WHEN** the user pans repeatedly in one direction, at any zoom level
- **THEN** part of the media remains visible in the viewer
- **AND** no recovery control is needed to bring it back

#### Scenario: Double-click and double-tap fit the media
- **WHEN** the user double-clicks the media, or taps it twice in quick succession with a touch pointer
- **THEN** the media returns to fit, scaled and centered

#### Scenario: A double-click on the empty backdrop fits rather than closes
- **WHEN** the user has panned the media aside and double-clicks or double-taps the empty backdrop
- **THEN** the media returns to fit
- **AND** the viewer remains open

#### Scenario: Arrow keys pan the media
- **WHEN** the viewer is open and the user presses an arrow key, or Shift with an arrow key
- **THEN** the view moves a step in that direction, or a larger step with Shift

#### Scenario: Toolbar and keys operate the viewer
- **WHEN** the viewer is open and the user activates zoom in, zoom out or fit, or presses `+`, `-`, `0` or `f`
- **THEN** the corresponding zoom in, zoom out or fit is applied

#### Scenario: Zoom is clamped
- **WHEN** the user keeps zooming in, or keeps zooming out
- **THEN** the scale stops at the viewer's maximum, or at its minimum

### Requirement: The viewer closes only on deliberate dismissal
The viewer SHALL close on Escape, on its close control, or on a single click or tap on the empty backdrop around the media once no second press has followed within the double-tap interval. A drag, a pan, a pinch, a double-click or double-tap, or a click or tap on the media MUST NOT close it, and the press that closes it MUST NOT reach the page beneath. Closing SHALL return keyboard focus to the element that opened it when that element still exists.

#### Scenario: Escape closes the viewer and returns focus
- **WHEN** the viewer is open and the user presses Escape
- **THEN** the viewer closes
- **AND** keyboard focus returns to the media that opened it

#### Scenario: A click on the empty backdrop closes the viewer
- **WHEN** the viewer shows media at fit and the user clicks or taps the empty area beside it without dragging, and presses nothing more within the double-tap interval
- **THEN** the viewer closes

#### Scenario: The tap that closes the viewer reaches nothing beneath it
- **WHEN** on a touch screen the user taps the empty backdrop above media or a link on the page beneath
- **THEN** the viewer closes
- **AND** nothing on the page beneath is activated, so no other viewer opens and no link is followed

#### Scenario: A pan gesture never dismisses the viewer
- **WHEN** the user drags across the viewer with one finger or the mouse, at any speed and starting anywhere, including the empty backdrop
- **THEN** the viewer remains open

#### Scenario: A click on the media does not close the viewer
- **WHEN** the user clicks or taps the media inside the viewer
- **THEN** the viewer remains open

#### Scenario: A press that crosses the media's edge does not close the viewer
- **WHEN** the user presses on the media and releases just beside it, or presses beside it and releases on it, without dragging
- **THEN** the viewer remains open

#### Scenario: A tap before the media has loaded closes the viewer
- **WHEN** the viewer is open on an image that has not loaded yet, so it shows only the empty backdrop, and the user clicks or taps it without dragging
- **THEN** the viewer closes

#### Scenario: A backdrop tap straight after a tap on the media closes the viewer
- **WHEN** the user taps the media and then, within the double-tap interval, taps the empty backdrop close by
- **THEN** the viewer closes rather than fitting the media as a double-tap would

### Requirement: The viewer keeps its media distinct and uncovered
Media in the viewer SHALL be drawn with an edge and a shadow, so it stays distinct from the backdrop in both themes. Fit SHALL place the media between the caption and the toolbar, so that neither covers it, unless together they would leave less than half the viewer's height.

#### Scenario: Light media on a light backdrop keeps its edge
- **WHEN** the viewer shows a mostly white image in the light theme, panned so that only a strip of it is in view
- **THEN** the image's edge and shadow set it apart from the backdrop

#### Scenario: Tall media fits clear of the toolbar
- **WHEN** the viewer opens on media taller than it is wide
- **THEN** the media at fit ends above the toolbar, and below the caption when there is one

### Requirement: The viewer's focus ring follows the keyboard
Opening the viewer SHALL move keyboard focus to its close control. That control SHALL show a focus ring when the viewer was opened from the keyboard; when it was opened by a click or a tap, no ring SHALL show until a key is pressed in the viewer.

#### Scenario: A tap opens the viewer without a focus ring
- **WHEN** the user taps media at fit on a touch screen
- **THEN** the viewer opens with focus on its close control and no focus ring
- **AND** once the user presses a key in the viewer, the focused control shows its ring

#### Scenario: A keyboard open shows the ring
- **WHEN** the user presses Enter on focused media
- **THEN** the viewer opens with a focus ring on its close control

### Requirement: Raster media offers actual pixels
For raster media, the viewer SHALL offer a "1:1 actual pixels" action that shows one image pixel per device pixel, its native size. Once the user has zoomed raster media in past fit, inline or in the viewer, its pixels SHALL render as sharp blocks while it is shown larger than its native size. At fit it SHALL be smoothed, even when fitting enlarges it. SVG and Mermaid media SHALL NOT offer this action.

#### Scenario: Actual pixels shows the image at native size
- **WHEN** the viewer shows a 3000×2000 screenshot at fit and the user activates "1:1 actual pixels"
- **THEN** each image pixel covers one device pixel

#### Scenario: Enlarged raster pixels stay sharp
- **WHEN** a raster image is zoomed beyond its native size, inline or in the viewer
- **THEN** its pixels are rendered as sharp-edged blocks without smoothing

#### Scenario: A raster is smooth at fit and sharp once zoomed past its native size
- **WHEN** a raster image is shown at fit covering more device pixels than it has, such as a 200-pixel-wide PNG laid out 200 CSS pixels wide on a 2× display, or a small image the viewer enlarges to fit
- **THEN** it is smoothed, inline and in the viewer
- **AND** once the user zooms it in past fit it renders as sharp-edged blocks
- **AND** returning it to fit smooths it again

#### Scenario: Actual pixels is reachable on a dense, pinch-zoomed screen
- **WHEN** the viewer shows a 640×480 image on a 3× display, on a page pinch-zoomed to 2×, and the user activates "1:1 actual pixels"
- **THEN** each image pixel covers one device pixel, even though that scale is below the viewer's usual minimum

#### Scenario: Vector media has no actual-pixels action
- **WHEN** the viewer shows an SVG or a Mermaid diagram
- **THEN** no "1:1 actual pixels" action is offered

#### Scenario: A responsive image that changes format changes its actions
- **WHEN** the viewer shows a responsive image and the source the browser picks for it changes between a raster image and an SVG, as the window is resized
- **THEN** the viewer shows the new source and offers "1:1 actual pixels" only while that source is the raster image

### Requirement: Images of unknown format are treated as vector
An image SHALL count as raster only when its format is known: a workspace file whose extension is not SVG, a `data:` URL with a raster image MIME type, or a cross-origin URL with a raster file extension. An image whose format cannot be determined reliably, such as a cross-origin URL without a recognizable extension, SHALL be treated as vector: no "1:1 actual pixels" action and smooth scaling.

#### Scenario: A badge service image is treated as vector
- **WHEN** the viewer shows a cross-origin image whose URL has no recognizable SVG or raster extension
- **THEN** no "1:1 actual pixels" action is offered
- **AND** enlarging it never renders its pixels as sharp blocks

#### Scenario: A cross-origin PNG keeps actual pixels
- **WHEN** the viewer shows a cross-origin image whose URL ends in `.png`
- **THEN** the "1:1 actual pixels" action is offered

### Requirement: Vector media stays sharp at every zoom
SVG files, SVGs embedded in documents, SVG chat visuals and Mermaid diagrams SHALL be redrawn at the displayed scale once zooming settles, inline and in the viewer, so lines and text stay sharp at every zoom level.

#### Scenario: A zoomed SVG is sharp
- **WHEN** the user zooms an SVG to 6× and stops
- **THEN** its lines and text are drawn at the displayed scale without visible pixelation

### Requirement: SVG media stays inert
Zooming MUST NOT change how SVG content is loaded. SVG files, document SVGs and SVG chat visuals SHALL remain image elements, in the viewer as well as inline, so their scripts, links and external resources stay inert. The viewer SHALL accept chat media only from an in-browser object (`blob:`) URL or the workspace's own origin. Mermaid diagrams SHALL keep their existing strict rendering.

#### Scenario: An SVG with script stays inert when zoomed
- **WHEN** an SVG file containing a script element is zoomed inline and opened in the viewer
- **THEN** the script does not run in either view

#### Scenario: A chat image from another origin is not shown
- **WHEN** a chat image's source resolves to an origin other than the workspace's, and is not an in-browser object (`blob:`) URL
- **THEN** the viewer does not open for it

### Requirement: Zoom survives edits to the shown file
When the shown file changes on disk and the preview re-renders, inline zoom and an open viewer SHALL keep their scale and pan and show the new content. Images SHALL be matched by resolved source (without the revision parameter) and link, copies by order, and Mermaid diagrams by position. Media whose aspect ratio changed, or that cannot be matched, SHALL reset to fit. The viewer SHALL stay open. A file only a `<source>` `srcset` names is not refreshed live (document-watch-index boundary).

#### Scenario: An edited image keeps its zoom
- **WHEN** a raster image file is zoomed inline to 3× and is rewritten on disk with the same aspect ratio
- **THEN** the new image is shown at 3× with the same pan

#### Scenario: An open viewer swaps in new content
- **WHEN** the viewer is open and zoomed on a document's second Mermaid diagram, and the document is edited without changing its number of diagrams
- **THEN** the viewer stays open at the same scale and pan
- **AND** it shows the re-rendered second diagram

#### Scenario: A changed aspect ratio resets to fit
- **WHEN** a zoomed image is replaced on disk by one with a different aspect ratio
- **THEN** the image resets to fit, inline and in an open viewer

#### Scenario: A new shape in a fixed box resets to fit
- **WHEN** a zoomed image whose width and height the document fixes is replaced on disk by one with a different aspect ratio
- **THEN** the image resets to fit, although its box keeps its size

#### Scenario: Media that became small resets to fit
- **WHEN** zoomed inline media is replaced by a copy rendered under 96 CSS pixels on a side
- **THEN** that copy is shown at fit without inline zoom controls

#### Scenario: Removing one copy of an image keeps the other's zoom
- **WHEN** a document shows an image unlinked and then linked, the linked copy is zoomed inline and open in the viewer, and an edit removes the unlinked copy
- **THEN** the linked copy keeps its inline zoom, and the viewer keeps it and its "Open link" action

#### Scenario: A responsive image whose shown source is replaced resets to fit
- **WHEN** a zoomed `<picture>` image is edited so that the `<source>` the browser shows is replaced while its fallback `<img>` source stays
- **THEN** the image resets to fit

#### Scenario: A file only a responsive image's `<source>` names is not refreshed live
- **WHEN** the file a `<picture>` image's `<source>` names changes on disk and the document does not
- **THEN** the image keeps showing the content it loaded, as the document-watch-index `srcset`/`<picture>` exclusion provides

#### Scenario: A change in diagram count resets diagrams
- **WHEN** a document with zoomed Mermaid diagrams is edited so that its number of diagrams changes
- **THEN** every Mermaid diagram in that document resets to fit
- **AND** an open viewer showing one of them stays open and resets to fit

#### Scenario: Removed media resets an open viewer to fit
- **WHEN** the viewer is open on a document image and the edit removes that image from the document
- **THEN** the viewer stays open, keeps showing the content it had, and resets to fit

#### Scenario: Media removed while the viewer is still loading it
- **WHEN** the viewer has just opened on a document image that has not finished loading, and an edit removes that image
- **THEN** the viewer finishes loading the image and shows it at fit

### Requirement: Selecting another file discards zoom
Selecting a different file, by user navigation or by Follow, SHALL close the viewer and discard all inline zoom for the previous file.

#### Scenario: Follow moves to another file
- **WHEN** the viewer is open on an image and Follow selects a different file
- **THEN** the viewer closes
- **AND** returning to the original file shows its media at fit

#### Scenario: The previous file's media opens nothing while the next loads
- **WHEN** another file has been selected and is still loading, and the user clicks media of the previous file still on screen or activates its inline zoom controls
- **THEN** the viewer does not open
- **AND** that media stays at fit

### Requirement: Zoom state is never persisted
Zoom scale and pan SHALL exist only in the page's memory for the media currently shown. They MUST NOT be written to application state, browser storage, personal workspace state, or the URL.

#### Scenario: A reload starts at fit
- **WHEN** the user zooms inline media and reloads the page
- **THEN** the media is shown at fit
- **AND** no zoom value was written to storage or to the URL
