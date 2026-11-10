/** Permanent logical-occurrence admissions per message, including refusals. */
export const VISUAL_MAX_COUNT = 8;

/** Opaque snapshot ids, never client-supplied filesystem paths. */
export const CHAT_VISUAL_ID_PATTERN = /^[a-f\d]{64}$/;

/** Agent-authored visuals, in document order (including refused occurrences). */
export type ChatVisualInput = {
  index: number;
  /** Source occurrence identity, independent of later reference resolution. */
  key?: string;
  kind: "file" | "svg";
  source: string;
  alt: string;
  complete: boolean;
};

/** At most eight admitted references; omitted occurrences are limit refusals.
 * Image bytes never ride the conversation stream.
 */
export type ChatVisualSnapshot = {
  /** Current rendered occurrence position, not the admission slot (may exceed 7). */
  index: number;
  status: "ready" | "pending" | "unavailable";
  id?: string;
  mimeType?: string;
  message?: string;
};
