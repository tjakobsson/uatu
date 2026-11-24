// What a failed `git fetch` said, in one of four kinds. Shared by the Hub's
// worktree fetches (src/hub/worktree-fetch.ts) and the session child's
// narrow pull request fetch (src/document/pull-request-refs.ts), which word
// the outcome for their own surfaces. Git's text itself is never forwarded:
// it can name local paths or, from older Git, a URL with credentials.

export type GitFetchFailureKind = "missing-ref" | "authentication" | "network" | "other";

// Authentication is decided before network: "unable to access … 403" is an
// authentication problem whose text also matches the transport patterns.
const AUTHENTICATION_PATTERNS = [
  /authentication failed/i,
  /permission denied/i,
  /could not read (?:username|password)/i,
  /terminal prompts disabled/i,
  /access denied/i,
  /\b(?:401|403)\b/,
  /repository not found/i,
  /invalid username or (?:password|token)/i,
  /publickey/i,
  /host key verification failed/i,
];

const NETWORK_PATTERNS = [
  /could not resolve host/i,
  /connection (?:refused|reset|timed out)/i,
  /network is unreachable/i,
  /no route to host/i,
  /operation timed out/i,
  /unable to access/i,
  /failed to connect/i,
  /does not appear to be a git repository/i,
];

// `missing-ref` only when the caller fetched a named ref the remote answered
// it doesn't have (a wrong pull request number, or a remote that isn't the
// pull request's GitHub repository).
export function classifyGitFetchFailure(stderr: string, options: { namedRef?: boolean } = {}): GitFetchFailureKind {
  const text = stderr.trim();
  if (options.namedRef && /couldn't find remote ref|no such ref/i.test(text)) return "missing-ref";
  if (AUTHENTICATION_PATTERNS.some(pattern => pattern.test(text))) return "authentication";
  if (NETWORK_PATTERNS.some(pattern => pattern.test(text))) return "network";
  return "other";
}
