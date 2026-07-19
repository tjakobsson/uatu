# add-desktop-glass-titlebar Tasks

## 1. Window chrome (Swift)

- [x] 1.1 In `ContentView`'s `WindowResolver` hook, insert
      `.fullSizeContentView`, set `titlebarAppearsTransparent = true` and
      `titleVisibility = .hidden`; confirm idempotence on re-resolution
- [x] 1.2 Make the hosted web view span the full frame (ignore the top safe
      area) so page content reaches the top window edge
- [ ] 1.3 Verify dragging by the titlebar region, toolbar buttons, and
      traffic lights all still work over web content

## 2. Inset contract (Swift)

- [x] 2.1 Compute the covered-chrome height from the window's
      `contentLayoutRect` and install a document-start `WKUserScript` that
      sets `uatu-desktop-host` + `--titlebar-inset` on the document root
- [x] 2.2 Observe `contentLayoutRect` changes (native tab bar appear/
      disappear, toolbar changes) and push inset updates to the live page;
      refresh the user script's baked value for future reloads
- [x] 2.3 Apply the same resolved inset as top padding to the split-browser
      pane's tab strip and to the launcher/starting/failure layouts

## 3. Inset consumption (SPA)

- [x] 3.1 Add `html.uatu-desktop-host` CSS: top padding/offsets on the
      sidebar pane and the preview sticky-header zone from
      `var(--titlebar-inset, 0px)`, chosen so sticky headers clear the
      toolbar while scrolled content passes beneath it
- [x] 3.2 Verify the terminal panel and any other full-height chrome
      surfaces against the inset (adjust only if they reach the top strip)
- [x] 3.3 Confirm the no-marker path is byte-identical layout for browser
      and PWA

## 4. Verification

- [x] 4.1 E2E test for the SPA contract: inject the marker class + variable,
      assert chrome offsets apply and that no interactive control lies in
      the covered strip; assert no layout change without the marker
- [ ] 4.2 Build the desktop app (`bun run build` then Xcode build) and
      manually verify: glass toolbar over content in light and dark, frost
      flowing to the top edge, native tab bar case updating the inset live,
      launcher and failure states, split pane tabs reachable
- [x] 4.3 Run `bun test`, `bun test:e2e`, and desktop CI's build path
