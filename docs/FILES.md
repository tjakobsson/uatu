# Files

Use **All** for the folder tree, **Recent** for a flat list ordered by the
file's latest disk write, or **Changed** for files changed against the selected
review base. Opening a file does not change its position in Recent. The Files
view is saved per account and workspace; changing it does not steer another
open browser or change the current preview or Follow.

The filename/path filter searches file metadata, independently of project
content search. Its query stays in place when switching views. The quiet count
reports all matching file entries, including those in collapsed folders or
outside the visible list. Indexing and retry status remain separate.

Recent rows show the filename, containing path, and relative write age, with
the exact timestamp available in file details. The tree retains its alphabetical
hierarchy and manual expansion while showing quiet recent-write cues.

## Ignored files and output folders

**Files options → Show ignored files** controls this browser's tree, Recent,
filename/path results, project content search, and document/image Follow
candidates. It starts enabled unless a saved preference or explicit legacy
default says otherwise. Turning it off preserves an open preview and does not
change another open browser's view. Ignored filenames and icons are muted;
unknown Git classification stays visible without an ignored/clean assertion.

Git-ignore rules no longer prevent authenticated direct file access. They are
browsing visibility. Use the watched root's `.uatu.json` `ignore.exclude` for
files that Uatu must not index or deliver. Mandatory secret, dependency, VCS,
and containment rules still apply. Uatu never edits your project configuration.

Initial visibility resolves in this order:

1. Saved personal `showIgnored` for the account and workspace.
2. Explicit `--no-gitignore`: show.
3. Any watched directory root explicitly setting `ignore.respectGitignore` to
   `true`: hide, independently of root order. Another root's explicit `false`
   does not override this fallback.
4. Otherwise: show, including when legacy values are absent or invalid.

Conflicting root defaults do not prevent startup. Root/policy recovery
recomputes this fallback; an open client's personal visibility remains its own.

These legacy controls supply initial visibility, not exposure policy. Existing
Uatu negations such as `!debug.log` can reveal individual Gitignored files while
other ignored rows remain hidden. Exposure exclusions are evaluated separately.

Build/dist remain excluded by default. To browse generated output, admit a
literal directory subtree in the watched root's `.uatu.json`:

```json
{
  "ignore": {
    "include": ["build/renders", "dist/previews"],
    "exclude": ["build/renders/private/**"]
  }
}
```

Only those subtrees and their necessary traversal ancestors are opened; sibling
outputs remain excluded. Missing directories are valid future output locations.
Absolute paths, parent traversal, globs, and existing file targets are invalid.
Includes do not bypass explicit exclusions, mandatory denied paths, or symlink
containment. Runtime configuration edits reconcile discovery and watch coverage.

## Audio and video

Use **All types**, **Audio**, or **Video** in Files options to combine type
filtering with the current view, filename/path query, and ignored visibility.
Recognized extensions identify playback candidates; actual container and codec
support depends on the browser. An ignored export appears in Recent but does
not become a Git change merely because it exists.

Opening a media filename shows a paused preview. Direct links, personal resume,
Back/Forward, discovery, and file writes never start playback. If another clip
is already playing, opening a different preview leaves that audition intact
until you explicitly press Play. Returning to the active clip reuses its session.

**Play** on a Recent row auditions it while keeping Files, the preview, and its
URL in place. Tree rows offer Play and Open preview through their action menu.
Auditioning disables Follow. One persistent player continues across Files,
Preview, Chat, Terminal, and desktop/touch presentation changes.

- **Previous/Next** use the eligible media order captured when you press a row's
  Play action. Later writes and filter changes do not reorder that comparison;
  removed or no-longer-permitted entries are skipped, and boundaries do not wrap.
- Each new clip starts at zero and releases the previous source. End-of-clip
  stops; it never advances to another file automatically.
- **Loop** repeats only the current clip. **Close** releases playback and pending
  transfers. Reloading the page or switching workspaces ends the session.
- Video can expand using the same active element, with fullscreen where the
  browser supports it. The dock reserves space above touch tabs and alongside
  the current surface rather than covering its last row or composer.

A detected overwrite shows **New render available** and disables stale looping.
**Reload** chooses the latest revision at zero, paused until Play. Write time
does not prove that a producer has finished rendering. Incomplete or unsupported
clips retain their filename, permitted download, and explicit retry/reload action.
Media uses independent bounded HTTP requests; no media bytes travel through
document JSON or the page's live-update stream. See the
[internal delivery contract](./INTERNAL-MEDIA.md) for developer details.

### Browser verification

Automated Chromium and WebKit checks decode and play the included PCM WAV and
H.264 Baseline fixtures, seek, loop, switch surfaces, expand the same video,
and close/reload without duplicate playback. Unsupported and incomplete media
retain download/retry states; recognizing an extension does not establish that
every codec in that container will play.

The user accepted the implementation for peer review. Physical iPhone/iPad Safari
and installed-PWA behavior was not independently verified by the agents, and
device-specific results were not recorded. Real-device review should cover
gesture playback, seeking, native video fullscreen, safe areas, keyboard
coexistence, and foreground resume. Browser touch/viewport simulation does not
establish physical-device behavior.
