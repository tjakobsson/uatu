## REMOVED Requirements

### Requirement: Warn about retired `.uatuignore` files on session start
**Reason**: The advisory was a transition aid for the 2026-04-27 `live-reload-ignore-rules` migration from `.uatuignore` to `.uatu.json tree.exclude`. The transition window has long passed; the warning module (`src/ignore/warning.ts`) is a whole file dedicated to a retired concept and carries ongoing maintenance cost for no remaining user benefit.
**Migration**: None required. `.uatuignore` files were already unparsed and had no filtering effect; after this change they are simply ordinary files with no special handling and no startup warning. Users who still have one can delete it or add its patterns to `.uatu.json tree.exclude`.
