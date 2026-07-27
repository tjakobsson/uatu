// Pure presentation helpers for the find bar: what the counter says, and what
// a selection is allowed to seed into the query box. Split out from
// `find-bar.ts` (which binds live DOM at module load) so the wording and the
// clamping rules can be unit-tested — the same split `outline-headings.ts`
// uses against `outline.ts`.

export type FindStatusState = "idle" | "ok" | "empty" | "invalid";

export type FindStatus = {
  state: FindStatusState;
  label: string;
};

// A selection longer than this is a paragraph, not a search term. Seeding it
// would fill the box with text nobody intends to search for and hide the
// placeholder that explains what the box is.
export const MAX_SEED_LENGTH = 120;

export function describeStatus(input: {
  query: string;
  total: number;
  currentIndex: number;
  truncated: boolean;
  error: string | null;
}): FindStatus {
  if (input.error !== null) {
    return { state: "invalid", label: "Invalid pattern" };
  }
  if (input.query.length === 0) {
    // An empty box is not a failed search; say nothing rather than "No
    // results", which would read as a verdict on a query never made.
    return { state: "idle", label: "" };
  }
  if (input.total === 0) {
    return { state: "empty", label: "No results" };
  }
  const position = input.currentIndex + 1;
  const total = input.truncated ? `${input.total}+` : `${input.total}`;
  return { state: "ok", label: `${position} of ${total}` };
}

// What a selection contributes to the query box when find opens.
//
// Multi-line selections are refused outright rather than joined: a query
// spanning a line break almost never matches anything, so seeding one would
// silently produce "No results" for a search the user did not type.
export function clampSeed(selection: string): string {
  const trimmed = selection.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SEED_LENGTH) {
    return "";
  }
  if (/[\r\n]/.test(trimmed)) {
    return "";
  }
  return trimmed;
}
