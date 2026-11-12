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

## What Uatu hides, and ignored folders

Uatu follows VS Code. The only files hidden by default are the ones VS Code's
`files.exclude` hides: `.git`, `.svn`, `.hg`, `.jj`, `.DS_Store` and
`Thumbs.db`. Dependency folders, build output, caches, virtual environments,
editor temporary files and secret-like files (`.env`, private keys, credential
files) are ordinary files. To keep something out of Uatu, list it in the
watched root's `.uatu.json`:

```json
{
  "ignore": {
    "exclude": [".env*", "*.pem", "id_*", "node_modules/"]
  }
}
```

Excluded paths are not indexed, listed, searched, followed or served, whatever
the visibility setting. Secret-like files are visible to anyone signed in to the
Hub, as they are to anyone with the workspace open in VS Code; an authenticated
user can already read them through the terminal. Uatu never edits your project
configuration. `ignore.include` from earlier builds no longer has an effect and
produces a warning.

### Ignored files

**Files options → Show ignored files** controls this browser's tree, Recent,
filename/path results and project content search. It starts enabled unless a
saved preference or explicit legacy default says otherwise. Turning it off
keeps an open preview and does not change another open browser's view. Ignored
filenames, folders and icons are muted; unknown Git classification stays
visible without an ignored/clean assertion. Hiding ignored files does not deny
authenticated direct access.

Follow never jumps to a file Git ignores, shown or not, so a build or render
cannot take over the preview. A file you open inside an ignored folder still
refreshes when it is rewritten. A tracked file inside an output folder, such as
a committed `dist/index.html`, is followed like any other file.

Initial visibility resolves in this order:

1. Saved personal `showIgnored` for the account and workspace.
2. Explicit `--no-gitignore`: show.
3. Any watched directory root explicitly setting `ignore.respectGitignore` to
   `true`: hide, independently of root order. Another root's explicit `false`
   does not override this fallback.
4. Otherwise: show, including when legacy values are absent or invalid.

Uatu negations such as `!debug.log` or `!build/renders/**` keep matching
Gitignored files visible while other ignored rows are hidden. Use the `/**`
form for a folder: `!build/renders/` alone does not match the files inside it.

### Folders read on demand

A folder Git ignores as a whole, such as `node_modules/` or `build/`, appears as
one muted row and is not read when the session starts. Expanding it reads that
level: its files and subfolders appear, the file count grows, and the level
stays current for everyone with the workspace open. Deeper folders are read when
you expand them in turn. If reading a folder fails, the row says so; expand it
again or choose **Retry listing** from its menu.

Files written inside an ignored folder while the session runs appear in Recent,
the tree and the Audio/Video filters without expanding anything, so a fresh
render can be played at once. Uatu keeps the newest 2,000 such files per watched
root; older ones come back when you expand their folder, and a file you have
opened stays available. Files written before the session started appear once
their folder is expanded.

Updates from ignored folders are sent in batches, at most once a second while a
build or install is writing, so they never delay an ordinary edit.

Limits:

- Outside a Git repository nothing is ignored, so every folder is read at
  startup. Use `ignore.exclude` to keep a large `node_modules/` out.
- In polling mode (`--poll`), files written inside a folder nobody has expanded
  are not seen until the folder is expanded, and a folder Git starts ignoring
  after startup is read like any other.

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
