# Design

## Context

See [proposal.md](proposal.md) for motivation and scope, and
[specs/media-zoom/spec.md](specs/media-zoom/spec.md) for the behaviour
contract.

What exists today:

- **Mermaid viewer.** `src/preview/mermaid-viewer.ts` is the only zoom code.
  It mounts one `<dialog class="mermaid-viewer">` on `document.body`, clones
  the inline SVG and re-namespaces its ids (`remapSvgIds`), and applies
  `translate() scale()` to a stage. Scale is clamped to 0.2–8, and every pan
  keeps 48px of the stage visible (`clampTranslation`). A map of live
  pointers selects the gesture (one pans, two pinch, three or more are
  ignored), with tap timing for double-tap and native `dblclick` for the
  mouse. The toolbar has zoom out, zoom in, fit and close, and the keys are
  `+`/`=`, `-`/`_`, `0`/`f` and Escape. Focus returns to the trigger. Styles
  are in `src/styles.css` (about lines 3757–3890), including
  `touch-action: none`, `100dvh` sizing, safe-area insets and 44px
  coarse-pointer targets. `closeMermaidViewer()` runs on every preview
  mount (`mount.ts`, `image.ts`, `empty.ts`, `binary.ts`, `diff.ts`,
  `commit-message.ts`), which is why a file edit currently closes the viewer.
- **Inline Mermaid.** `normalizeRenderedDiagram` in `src/render/preview.ts`
  wraps the SVG and an expand badge in `button.mermaid-trigger`
  ("Open diagram in fullscreen viewer"). `src/preview/mermaid.ts` opens the
  viewer on click. Diagrams render lazily through a FIFO queue, and a theme
  change re-renders them.
- **Image file preview.** `src/preview/image.ts` mounts
  `div.image-preview > img`. On a new revision it moves the existing
  element's source in place instead of rebuilding it.
- **Document images.** These are plain `<img>` elements mounted through
  `preparePreviewHtml` (`src/preview/svg-images.ts`). An SVG off-screen
  holds a placeholder `src`; `previewImageSource(img)` returns the real one.
  `refreshImageRevisions` adds a `revision` query parameter to watched
  files. A file edit replaces the whole preview body
  (`renderSinglePayload` → `replaceChildren`).
- **Chat.** Visuals render as `button.chat-visual-enlarge > img`
  (`src/chat/markdown.ts`). Attachment thumbnails render as
  `button.chat-attachment-view > img` (`timeline-renderer.ts` and the
  composer strip in `ui.ts`). One delegated `[data-attachment-view]` click
  handler in `src/chat/ui.ts` validates the URL (`blob:` or same origin) and
  opens `#chat-image-viewer` (`src/index.html`), which any click closes. Its
  close handler blurs a restored `.chat-timeline` focus to work around a
  Safari focus ring.
- **Touch.** In touch mode the page scrolls (`preview-scroll-root.ts`). No
  preview element sets `touch-action`, so a pinch zooms the page, which
  `text-size.ts` exists to avoid for text. Find skips SVG subtrees
  (`src/find/text-index.ts`).

Constraints: no new dependency. Client URLs go through `appUrl()`.
`appState` must not hold zoom. `src/` stays product code, with unit tests
colocated. Shared helpers must not reach into `app.ts`, because
circular-import TDZ bugs have happened there.

## Goals / Non-Goals

**Goals:**

- One engine for transform math and gestures, used by both inline zoom and
  the viewer, so behaviour matches everywhere.
- Surfaces opt in through a small adapter rather than the zoom code knowing
  about the preview or chat.
- Move the existing Mermaid viewer behaviour across intact, keeping it
  covered by its existing E2E tests, which are updated only for selectors and
  for the deliberate behaviour changes.

**Non-Goals:**

- Zoom for video, audio, PDF or the terminal.
- Inline wheel or trackpad zoom.
- Persisted or shareable zoom.
- Changing Mermaid's rendering pipeline, the SVG visibility loader, or the
  touch text-size stepper.
- Inlining SVG or using `<object>` for it.

## Decisions

### 1. A new `src/zoom/` feature folder with no surface imports

Modules:

- `transform.ts`: pure math for `{tx, ty, scale}`. It covers clamping,
  point-anchored zoom, pinch (computed from the pinch's start, so the media
  point under the fingers' starting midpoint follows the midpoint as it
  moves), fit and centring (optionally between bands the content keeps
  clear of: the viewer's caption and toolbar), and two pan-bound policies:
  *keep-visible* (96px; the old viewer kept 48px, raised so a strip of light
  media on a light backdrop still stands out) and *cover* (inline: the
  zoomed media always covers its box, and scale never drops below fit).
- `gestures.ts`: the pointer-map state machine lifted from the Mermaid
  viewer. It turns input points into pan, pinch, tap and double-tap
  intents. It takes plain `{id, x, y, time, type}` records so it can be
  unit-tested without a DOM and fed by either Pointer or Touch events.
- `motion.ts`: what both surfaces do with those intents. `gestureZoom`
  turns pan and pinch intents into transforms from the baseline taken when
  each gesture (re)starts, and reports how far a pan asked to go past the
  surface's bound (`panOverflow`); `keyPan` turns arrow keys into a pan; and
  `RestCommit` runs the commit-at-rest protocol (decision 5). Each surface
  keeps its own pan bound, zoom range, layout writes and tap behaviour.
- `announce.ts`: the polite status region that announces a zoom level a
  control or key set. Levels are relative to fit (100% is fitted) on both
  surfaces, because fit is where every zoom starts and returns to, and media
  without a natural size (Mermaid, viewBox-only SVG) has nothing else to be
  relative to.
- `media.ts`: the media descriptor. It records the kind (`raster`,
  `svg-image` or `mermaid`), the real source, the identity key, the enclosing
  link, the aspect ratio, and the small-media test (either rendered side
  below 96 CSS px).
- `inline.ts`: the inline controller. It builds the frame and toolbar,
  switches `touch-action`, and handles snapshot and restore across
  re-renders. `createZoomCarry` is the per-surface store of zoom saved by
  identity; the preview creates one (decision 6).
- `viewer.ts`: the shared `<dialog>`, generalized from `mermaid-viewer.ts`.
  `remapSvgIds` moves with it.

`src/zoom/` imports nothing from `preview/`, `chat/` or `shell/`. Surfaces
pass in what they know: the real source for an image
(`previewImageSource` for the preview), how to follow a link, where to
return focus, and a URL guard. The preview integration lives in a thin
`src/preview/media-zoom.ts`. Chat's way into the viewer, with its URL guard,
is `src/chat/media-viewer.ts`; inline zoom on assistant visuals is attached
in `src/chat/visual-ui.ts`, and `src/chat/ui.ts` keeps only the delegated
attachment click handler.

*Alternative considered:* keep the viewer in `preview/` and import it from
chat. Rejected: chat would depend on the preview folder, the engine would
stay tied to Mermaid, and the import graph gains a cycle risk.

### 2. Frame and toolbar markup that never nests controls

Each zoomable media gets a clipping frame (`overflow: hidden`). The frame
takes on the media's at-fit layout box (`display: inline-block`,
`max-width: 100%`, `line-height: 0`, the image's own vertical alignment),
so at fit nothing moves. Inside the frame are:

- the **clip**, the box a zoom is cut to. At fit it is `display: contents`,
  so it adds no box and the activator lays out as it would in the frame;
  zoomed, it is the frame's box with `overflow: hidden`;
- the **activator**, inside the clip, the one focusable, named element for
  the media;
- the **stage**, the element that is transformed;
- the **toolbar**, the clip's sibling, never inside the activator and never
  clipped. Over media at least 200 CSS px wide it sits in the top-right
  corner. Narrower media (`COMPACT_MEDIA_PX`) would be hidden by it (a 134px
  diagram under a 120px toolbar), so there it sits outside the frame: above
  it, or below it when the space above is out of view, which a hit test
  decides as the toolbar is about to show (a sticky header over the content,
  the top of the window or scroller).

The toolbar group is named after its media ("Zoom controls for" and its alt
text, or "diagram"), with names in attributes so Find gains no text. An
image, `<picture>` or link activator keeps its alt or authored name and is
described as opening the viewer (`aria-description`), since nothing else
tells a screen-reader user that activating an image opens a viewer. Buttons
(Mermaid, chat visuals) already name that action and get no description.

| Surface | Activator | Stage |
|---|---|---|
| Inline Mermaid | `button.mermaid-trigger`, keeping its name and `cursor: zoom-in` | the SVG |
| Linked document image | the existing `<a>`; the frame wraps the link when the image is its only content | the `<img>` |
| Other document image | the `<img>`, made a `tabindex="0"` button with the image's alt as its name | the `<img>` |
| Responsive document image | its `<picture>` (or the link holding only it), made a button like a plain image, so the `<img>` stays the `<picture>`'s direct child and the browser still picks its source | the `<img>` |
| Chat visual | the existing `button.chat-visual-enlarge` | its `<img>` |
| Attachment thumbnail | the existing `button.chat-attachment-view` (viewer only: no frame or toolbar) | — |

Attachment thumbnails are viewer-only at every size. They render at up to
128×96 CSS px, so some are above the small-media floor, but a thumbnail is a
cropped preview of a larger image: zooming the preview inline would inspect
the crop, not the image. Activating one opens the viewer on the full image,
as before, and the viewer is where it zooms.

The activator is always in the tab order, since it is the media's one
control and the keyboard must reach whatever a click opens. A plain image or
`<picture>` is given `tabindex="0"`; a link its author took out of the tab
order (`tabindex="-1"`, which the sanitizer allows) has that tabindex
removed. Leaving such a link unframed was the alternative, but then a linked
image would open the viewer or not depending on an attribute readers cannot
see.

A linked image is framed only when it is the link's only content, apart from
whitespace. An image that shares its link with text, a caption or other
elements stays a plain link, with no frame, toolbar or viewer: framing it
would nest controls in the link, and moving the toolbar outside the link
would need positioning this design does not have. Such links are rare in
Markdown, and the spec excludes them.

Mermaid's expand badge becomes the toolbar's expand control. The
small-media test measures the media itself (the stage's content box), not
the frame, which also holds margins such as an image's `hspace`. It runs
whenever the frame's box changes (a `ResizeObserver`), because the box is
only known after the image loads. Once zoomed, those margins move from inside
the frame onto it: the frame is then the media's own box, which the zoomed
stage covers from its origin under the cover bound, and its margin box, with
the layout around it, is the one it had at fit. Kept inside, the stage would
sit offset by its margin while the pan bound assumed the frame's origin, and
panning to the left or top edge would show a blank strip. A frame starts out small, with no inline controls, until it has been
measured: hover applies before any pointer event reaches the page, so
measuring on hover would flash the toolbar on small media.

An image sized against its containing block cannot be sized against the
shrink-to-fit frame. Such a frame is marked fluid and takes the width
instead: an image with a percentage `width` hands the percentage to the frame
and fills it, and an SVG with only a viewBox, which has no natural width,
gets the full width. Fluid sizing is decided when the image loads and again
when the frame or its container changes size, so an image that loaded while
hidden (a chat visual's Source tab) is fixed once it is shown: a collapsed
frame's own box is empty both hidden and shown, so only its container's
changes.

*Alternative considered:* transform the `<img>` with no wrapper and clip it
with `clip-path` or `object-view-box`. Rejected: `clip-path` moves with the
transform, and `object-view-box` is not available in Safari.

### 3. The input type decides the interaction, not the UI mode

The desktop and touch rules in the spec follow the input: Pointer Events
`pointerType`, `(hover: hover)` for showing the toolbar on hover, and
`(pointer: coarse)` for 44px targets. Keyboard focus (`:focus-visible`
within the frame) shows the whole toolbar whatever the pointer, so a
touch-first device with a keyboard gets it; a tap's focus is not
`:focus-visible`, so touch at fit still shows none. An iPad in desktop mode therefore
still gets the touch gestures, matching the 44px rule the viewer already
uses.

Touch handling inline:

- **At fit,** the frame has `touch-action: pan-x pan-y`. The browser keeps
  one-finger scrolling but will not start a page pinch on the media. A
  non-passive `touchstart`/`touchmove` listener calls `preventDefault` once a
  second touch is on the frame, and feeds both touches to `gestures.ts`.
  Pointer Events alone cannot do this, because the browser has usually
  started a scroll, and cancelled the pointers, before the second finger
  lands.
- **Once zoomed past fit,** the frame has `touch-action: none`, and pointer
  input drives one-finger pan and further pinches, as in the viewer.
  Returning to fit restores `pan-x pan-y`.

Inline media registers no `wheel` listener at all, so it cannot block
scrolling and cannot react to the wheel events a trackpad pinch produces.

Zoomed media would otherwise trap the page on a phone: under `touch-action:
none` every one-finger drag on it is a pan. So once a pan reaches the
media's top or bottom edge, what the cover bound holds back (`panOverflow`)
scrolls the nearest vertical scroller, and reversing the finger scrolls it
back before the media pans again. Mouse and pen drags stay on the media.
Arrow keys on a focused zoomed activator pan it (`preventDefault`, so the page
does not scroll); at fit they keep their default.

### 4. One viewer, generalized

`viewer.ts` keeps the existing viewer's structure, constants, gesture code
and CSS, renamed from `mermaid-viewer*` to `media-viewer*`. Its toolbar
order stays zoom out, the zoom level, zoom in and fit, then "1:1 actual
pixels" (raster only) and "Open link" (linked media only), then close. Both
toolbars draw one CSS icon per action from `data-zoom-action` (fit `⊡`,
expand `⛶`), so the viewer's fit no longer borrows inline expand's icon.
Zoom in and out are `aria-disabled` at the ends of the range, not
`disabled`, so a control pressed to its limit keeps keyboard focus inside the
modal. Arrow keys pan by 40px, 200px with Shift, like scrolling: ArrowDown
shows more of what is below. Fit keeps the media between the caption and the
toolbar (`fitBands`), measured as laid out, unless together they would take
more than half the height (a short landscape phone), where the media is
better fitted larger beneath them. The stage has an edge and a shadow in
both themes. Content comes from the descriptor:

- **Mermaid:** cloned SVG with remapped ids, as today.
- **Image kind.** `imageKind` in `media.ts` decides raster or vector. SVG is
  vector anywhere. A workspace file (same origin) is served with the type its
  extension gives it, so anything not SVG is raster. Extensions are read from
  the decoded path, as the server reads it (`figure%2Esvg` is `figure.svg`);
  a malformed encoding is read as written. A cross-origin image is
  raster only when its URL names a raster format (a raster extension, or a
  raster `data:` MIME type). Otherwise its format cannot be told, because a
  cross-origin response's type is not readable, so it is treated as vector:
  no "1:1 actual pixels" and no pixelation. This trades actual pixels on
  extensionless raster URLs (GitHub attachments) for never offering a
  raster action on an SVG (shields.io badges). The off-screen SVG loader
  still recognizes SVG by its source alone, as written: it does not decode
  the path, so loading is unchanged by zoom.
- **Image:** a fresh `<img>` whose `src` is the descriptor's real source.
  It is never the svg-images placeholder, which is why the surface supplies
  `previewImageSource`. SVG stays an `<img>`.

Backdrop dismissal: a press and release on the viewport that `gestures.ts`
classifies as a tap closes the viewer when the whole press was on the empty
backdrop: it both started and ended outside the media's rectangle
(`classifyPress`). A press that starts on the media and slides off it within
the tap slop, or the reverse, was aimed at the media. Drags, pinches, and
taps on the media never close it. A tap's target is decided before it can
pair with an earlier tap, so a tap on the media followed quickly by a tap on
the backdrop is a backdrop tap, not a double-tap. A backdrop tap closes only
once it has settled: a further press within the double-tap interval
(`DOUBLE_TAP_MAX_GAP_MS`) cancels it, so two taps or a double-click on the
backdrop fit the media (the mouse through the native `dblclick`), and closing
waits about 300ms. This applies
to every surface (see Assumptions). Before an image has loaded nothing is on
show, so a tap anywhere in the viewport is on the empty backdrop and closes
it; a drag still does not.

On touch the browser follows a tap with a synthesized click at the same
point, after the dialog may have closed, so it landed on the page beneath
(opening other media or following a link). The viewport cancels every
`touchend` (it takes no clicks itself; its toolbar is outside it), which
cancels that click. And closing is finished at once (`finishClose`), not on
the dialog's `close` event: browsers queue that event as a task, so a viewer
opened again in between had its new content cleared and its hooks run as the
old open's. The event still finishes a close the browser made itself
(Escape), unless the viewer has opened again, and an open finishes any close
still pending first.

The close control takes focus on open. Opened by a click or a tap (the
element focused at that moment does not match `:focus-visible`), the dialog
carries `data-pointer-opened`, which hides the focus ring until a key is
pressed in the viewer: WebKit counts programmatic focus after a tap as
keyboard focus. A press pans only once it can no longer
be a tap (past the tap slop, or a touch held past 400ms), so one press never
both moves the media and closes the viewer. The slop is 12px for a finger,
which lands imprecisely, and 4px for a mouse, which holds still to click: a
slow, short mouse drag is a drag, not a click. "Open link" closes the viewer
and then calls the link's own `click()`, so `src/preview/anchors.ts` and the browser
apply their usual rules: in-app documents load in the preview, external
links go to the browser.

`returnFocusTo` stays an option. A chat attachment thumbnail passes itself.
Framed media, in the preview and chat alike, passes its activator (the
preview's on its current copy) and moves on to expand when expand opened the
viewer: an inline toolbar is hidden until focus or the pointer is on its
media, so expand can take focus only once its activator has it
(`viewerFocusReturn` in `inline.ts`, the one rule both surfaces use). A toolbar change after
a re-render keeps the controls that stay in place, so keyboard focus survives
a live edit; a focused control that goes hands focus to close.

The dialog's CSS fills the layout viewport (`100dvw` × `100dvh`). While it
is open it is also placed on the visual viewport (through
`src/shared/visual-viewport.ts`, as the touch terminal does), so on a page the
reader has pinch-zoomed it covers what is visible, and its toolbar is scaled
back by the page zoom to keep its usual on-screen size. The toolbar is kept
inside the safe box and wraps into rows when its controls do not fit one
(six 44px controls on a 320px phone). When the viewport changes size (a
rotation, a resize), fitted media fits again and zoomed media keeps its
scale, brought back within the pan bound. The kept scale can then lie below
the new range (a viewport that grew raises the minimum fit had lowered), so
a relative zoom (a step, the wheel, a pinch) never moves against its
direction: from outside the range zoom out stays put rather than enlarging
the media, and zoom in moves up into the range.

Chat also passes an `afterClose` hook that
keeps its Safari `.chat-timeline` blur. The chat URL guard (`blob:` or same
origin) is `chatMediaSource` in `src/chat/media-viewer.ts`, in front of
`open()`. It is the guard the removed chat dialog had: any `blob:` URL is
accepted, without tracking which object URLs chat staged. Chat also passes the attachment's name (a visual's alt text) as an
optional caption, which the viewer shows as text across the top, as the
removed chat dialog did. The preview passes no caption, so the viewer adds no
text there.

A replacement brings its own kind: when it is swapped in, the viewer's
kind and toolbar follow it, under the same toolbar rule, so a `<picture>`
whose picked source turns from a PNG into an SVG (a resize, a rotation)
loses "1:1 actual pixels", and the reverse gains it.

The viewer owns two loads, each checked against what it would show. The
content on the stage is identified by a token bumped on every open, close and
swap; its own load (an image's first) is ignored only once one of those has
replaced it. At most one replacement is pending: the latest request. Any new
request supersedes it, including a request for the source already shown, so
A→B→A before B loads leaves A. Removing the media (`orphan`) abandons only
the pending replacement; content the open is still loading finishes and
fits.

`#chat-image-viewer` and its CSS are removed from `index.html` and
`styles.css`.

### 5. Sharp rendering: transform while moving, resize at rest

While a gesture runs, the stage moves only through `transform`, which is
cheap per frame. About 120ms after input stops, the engine *commits*. It
sets the stage's layout `width` and `height` to the scaled size and keeps
only `translate()`, so the browser redraws SVG and Mermaid at the displayed
scale. Raster media gets `image-rendering: pixelated` only once the reader
has zoomed it in past fit and its displayed device-pixel size then exceeds
its natural size. At fit it is smoothed as before, including a small image
the viewer enlarges to fit, and returning to fit smooths it again.
"1:1 actual pixels" sets the
scale so that one natural pixel equals one device pixel
(`1 / devicePixelRatio` CSS px, divided again by the page's pinch zoom,
`visualViewport.scale`, which `devicePixelRatio` leaves out). The viewer's
zoom range always includes that scale, even below its usual 0.2 minimum (a
640px image on a 3× screen of a page pinch-zoomed 2× needs 1/6). The
pixelation threshold counts device pixels the same way, through one rule
(`rasterEnlarged` in `media.ts`) for both surfaces. Inline, "past fit" is any
zoom (inline zoom never goes below fit); in the viewer it is a scale above
the current fit scale, so 1:1 counts only where it zooms in. "Natural" is
the bitmap's width: a `srcset` candidate reports its width over its density
descriptor, so inline measures that source from a copy loaded without one,
as the viewer shows it (smooth until known). A 200px PNG laid
out 200 CSS px wide on a 2× screen is enlarged at fit and still smooth there:
pixelating every such image would trade smoothing for jagged edges at the
fractional ratios documents are usually shown at.

The viewer keeps its `transform`-based API for tests: `readStageTransform`
reads the committed state through a `data-zoom-state` attribute instead of
parsing `style.transform`. `tests/e2e/transform-helpers.ts` changes to
match.

*Alternative considered:* toggle `will-change` and let the browser
re-rasterize. Rejected because it depends on browser heuristics and cannot
be asserted deterministically. Layout sizing gives an assertable size.

### 6. Keeping zoom across edits

A **zoom session** is identified by (selected document id, view mode,
layout). `src/preview/media-zoom.ts` hooks the mount paths that currently
call `closeMermaidViewer()`:

- **Same session** (a watched-file edit re-render): before the body is
  replaced, snapshot `{identity → state}`. After mount, restore each match.
- **Different session** (another file, by navigation or Follow; also a view
  mode or layout change): close the viewer and drop every inline state.
  Selecting another file does this at once, before that file has loaded, so
  a slow load never leaves the viewer open on the previous file, and a
  return to the first file before the second mounts carries nothing back.
  The previous file's body stays on screen until the next one mounts, but
  its media neither zooms (its controller asks `InlineZoomOptions.active`
  on each input) nor opens the viewer meanwhile, so it is still at fit if
  that file is selected again before the next one mounts: a mount makes the
  shown media current again, as does the image preview keeping its element
  in place for a file selected again.

Identity:

- **Image:** the resolved URL with the `revision` parameter removed, the
  same normalization as `dimensionsKey` in `svg-images.ts`, together with
  the resolved `href` of the link it opens. Copies sharing both (the same
  image behind the same link) are told apart by their order among those
  copies alone (`occurrenceIdentities` in `media.ts`), so an edit that
  removes another image, or a copy with another link, moves no zoom and no
  open viewer onto the wrong copy. Copies alike in source and link are
  interchangeable, so removing an earlier one hands its zoom to the next.
  A plain diff of the ordered list was considered and rejected as more
  machinery than this needs.
- **Responsive image:** everything that picks what it shows, its
  `<source>` elements' `srcset` (descriptors included) and `media` as
  authored, and its fallback `<img>` source, rather than the one shown.
  Sanitizing keeps no other selection attribute (`sizes`, `type`, an
  `<img>`'s own `srcset`). The browser picks a candidate only as it loads,
  after the new copy has to be matched, so an edit to any of them makes it
  another image, which starts at fit. For the same reason an open viewer
  follows a new copy of a responsive image only once that copy has loaded
  the source the browser picked (`currentSrc`), never its fallback, which
  it may never show; every other image is followed at once. A picked
  `<source>` counts as loaded even while an off-screen SVG fallback holds
  its placeholder. `srcset` carries no revision (`image-revision.ts`
  refreshes only an `<img>`'s `src`), so a change to a file only a
  `<source>` names is not refreshed live: the existing document-watch-index
  `srcset`/`<picture>` exclusion stands.
- **Mermaid:** `mermaid:<index>` among the document's `.mermaid` blocks. If
  the block count differs between snapshot and new mount, all Mermaid states
  are dropped.

Restore is deferred until the new media knows its size: image `load`, or
the diagram rendering out of the lazy queue. It applies the saved
fit-relative scale and pan only if the media's shape is within 1% of the
saved one; otherwise the media resets to fit. Shape is checked twice: the fit
box's aspect ratio, which scales the pan, and the image's intrinsic aspect
ratio, recorded when zooming began, because a page that fixes the box
(explicit `width` and `height`) hides a square image turning wide. Restore
goes through the same choke point as every other zoom, which refuses media
now under the small-media size: such a copy stays at fit with no inline
controls. The standalone image preview already keeps its element and swaps
the source in place, so it goes through the same check on `load`. Until an
image has loaded its real source (an off-screen SVG holds its placeholder),
its controller is at fit only because the restore has not happened, so a
further re-render keeps what was saved for it rather than saving that fit.
The controllers of a body about to be replaced are disposed once their zoom
is saved, so their observers (a frame watches itself and its container) do
not keep the old copy alive. That holds for every replacement, including a
binary notice, a commit, a diff, an empty state or a media player, which
release them without saving; only a selection change, whose body stays on
screen until the next mount, fits them instead. A diagram that a theme
change queued to render again in place has no frame until it renders, so
its zoom is read from the controller its last frame had: an edit before the
redraw still carries it.

The open viewer holds its descriptor's identity. After a re-render it
either:

- **Matches:** loads the new content, whether or not the new copy is on
  screen. The viewer loads an image's real source itself, as soon as a mount
  or an in-place revision refresh makes it known, rather than waiting for the
  inline copy (an off-screen SVG holds its placeholder and never loads). The
  diagram the viewer shows renders ahead of the lazy queue. An image is preloaded, then the
  `src` is swapped, so nothing blanks. A Mermaid diagram is re-cloned when
  its re-render completes. Scale and pan are kept, subject to the same
  aspect check, with the scale clamped to the new content's zoom range.
  Media at fit fits again. A replacement still loading when the media is
  removed is abandoned.
- **Does not match:** keeps showing what it had and resets to fit. Its
  "Open link" action goes: the link left the page with the media.

Chat needs no carry. `reconcileChatVisuals` keeps each visual's DOM node
across streamed re-renders of a bubble, keyed by its resolved source, so the
frame and its controller, and with them the inline zoom, simply stay. There
is no "different session" except leaving the conversation. A visual whose
image fails to decode loses its frame through `removeInlineFrame`
(`inline.ts`), which releases the controller before removing the frame, as
the preview does before replacing its body.

*Alternative considered:* key Mermaid by source hash. Rejected because the
agreed rule is position, which survives text edits inside a diagram.

### 7. Ephemeral by construction

Saved zoom lives in the carry `src/preview/media-zoom.ts` creates
(`createZoomCarry`), cleared on session change; live zoom lives on each
controller. Nothing touches `appState`, storage helpers or the URL. A
unit test asserts that `src/zoom/` imports none of `shell/state`,
`shell/storage`, `shell/personal-state` or `presentation-storage`.

## Assumptions and interpretations

- **Mermaid trigger restructure.** `button.mermaid-trigger` stays the
  activator with its accessible name. The badge leaves the button and
  becomes the toolbar's expand control, so no control is nested in a button.
  Chat's `button.chat-visual-enlarge` gets the same treatment.
- **Backdrop click everywhere.** The new closing rule (Escape, close, or
  empty backdrop) applies to Mermaid as well as chat, because there is one
  viewer.
- **Small media.** "Under about 96px" is read as either rendered side below
  96 CSS px, measured whenever the media's box changes.
- **Inline range and bounds.** Inline zoom cannot go below fit, and inline
  pan uses the *cover* bound, so no blank area shows inside the box. The
  viewer keeps 0.2–8 and a keep-visible rule (now 96px), except that its minimum reaches down
  to the fit scale for media that only fits below 0.2 (a 3000px screenshot on
  a phone), so fit always shows the whole media and zooming out stays there.
- **Actual pixels.** "1:1" means one image pixel per device pixel, and it is
  a viewer action only. The inline toolbar is exactly +, −, fit and expand.
- **Zoom level.** The viewer's readout is relative to fit, not to the
  media's natural size: 100% is fitted, as inline. So "1:1 actual pixels"
  reads as whatever multiple of fit it is.
- **What counts as a re-render.** View-mode and layout changes count as a
  different session; only re-renders of the same presentation keep zoom. A
  theme-driven Mermaid re-render is a same-session re-render.
- **Unmatched viewer content.** When the viewer's media can't be matched,
  the viewer keeps its last content at fit. It never switches to different
  media on its own.
- **Keyboard on zoomed media.** While media is zoomed inline a click or tap
  only pans, but Enter or Space on its activator still opens the viewer:
  keys have no pan to protect, and every zoomable media opens on Enter or
  Space.
- **Linked images and modifier clicks.** Modifier clicks (⌘, Ctrl, Shift,
  Alt) on a linked image keep the browser's default link behaviour, matching
  `anchors.ts`.
- **Find.** Find is unaffected: images and SVGs have no indexed text, and
  frames add no text nodes.
- **Text size.** The touch text-size stepper is unchanged.
- **Tests.** There are no separate touch Playwright projects (`e2e` and
  `perf` only). Touch coverage uses `test.use({ hasTouch: true, isMobile:
  true })` blocks, as `mobile.e2e.ts` and `ipad.e2e.ts` do. Any frame-budget
  test is tagged `@perf`. Tests never write into `openspec/`; PR screenshots
  come only from `UATU_E2E_SCREENSHOTS_DIR` at PR time.

## Risks / Trade-offs

- [Desktop inline zoom is buttons and drag only. Without wheel or trackpad
  pinch, reaching a high scale inline takes several clicks.] → This is the
  intended trade for never hijacking scroll. Expand is one click away, and
  the viewer has full wheel and pinch zoom.
- [Pinch at fit depends on `touch-action: pan-x pan-y` plus
  `preventDefault` on a second touch. iOS Safari may still start a page
  zoom, or cancel touches, in edge cases.] → E2E covers it with CDP
  multi-touch in the `hasTouch` blocks. A manual check on a real iPhone and
  iPad is a task, because emulation does not reproduce Safari's gesture
  arbitration.
- [The frame could change layout: baseline alignment of images in a line,
  or margins applied by `img` selectors in `.markdown-body`.] → The frame
  takes on the image's layout. E2E compares each fixture image's bounding
  box with and without the zoom integration.
- [Linked badges such as shields.io now open the viewer instead of the
  link, which is an extra step for README badge rows.] → This is agreed
  behaviour. "Open link" is in the viewer, and modifier clicks still follow
  the link directly.
- [Resizing at rest re-lays out large SVGs.] → It happens only once input
  stops, and the frame is `contain: strict` (the viewer's viewport already
  clips). No `@perf` budget test was added; one should be added if commit
  work on large diagrams shows up as slow in practice.
- [Restoring Mermaid zoom waits on the lazy queue. A diagram far off-screen
  restores only when it renders.] → This is acceptable because its state is
  invisible until then. An edit can move an open viewer's diagram off-screen,
  so that one diagram is rendered ahead of the queue
  (`setMermaidRenderPriority` in `src/render/preview.ts`).
- [Removing `#chat-image-viewer` touches tests in the in-flight
  `add-agent-chat-visuals` change.] → That change's requirement ("enlarge an
  image within chat and dismiss the viewer") still holds. Only selectors and
  the dismiss-by-any-click assertion change, and `chat-visuals.e2e.ts` is
  updated here rather than in that change's artifacts.

## Migration Plan

This is a single PR with no data or API migration. Rollback is a revert of
the PR; nothing is persisted, so no cleanup is needed.

`mermaid-rendering`'s Purpose line still mentions "an accessible fullscreen
pan-and-zoom viewer". Update it when this change is archived (it lives in
the main spec, outside this change's deltas).

## Open Questions

None that affect specs or tasks. The exact commit delay (about 120ms) and
the aspect-ratio tolerance (1%) can be tuned during implementation.
