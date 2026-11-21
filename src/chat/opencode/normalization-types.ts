/** This frame's start is only the first observed delta/end, not a native part
 * start. A retained row already owns its start; syntax completion must not
 * replace that established value with this subscription-local fallback. */
export const OPENCODE_TEXT_START_FALLBACK = Symbol("opencode-text-start-fallback");
export type OpenCodeTextStart = { readonly [OPENCODE_TEXT_START_FALLBACK]?: boolean };

/** V1 source-local idle alias on a raw provider event, witnessed after that
 * source's latest idle status and before a subsequent busy/retry status, ahead
 * of cross-stream deduplication. It repeats an already queued idle status; the
 * V1 normalizer reports that as the neutral repeat-status fact. No execution
 * identity or timestamp is inferred from the session/user ids. */
export const OPENCODE_COMPLETION_ALIAS = Symbol("opencode-completion-alias");
export type OpenCodeCompletionAlias = { readonly [OPENCODE_COMPLETION_ALIAS]?: true };
