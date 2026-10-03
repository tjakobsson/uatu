/**
 * Classifying how a started login is finished, and confining a pasted
 * redirect address to the one loopback listener the agent opened for it
 * (design D4).
 *
 * A browser login whose `redirect_uri` is a loopback address only completes
 * when the browser runs on the Hub machine. From anywhere else, the provider
 * redirects the browser to `http://localhost:<port>/…`, which fails to load,
 * and the user pastes that address. The Hub then requests it on the Hub
 * machine, where the agent's listener is waiting. That is a request to a
 * user-supplied URL, so it is allowed only for the exact callback the attempt
 * recorded.
 */

import type { AccountCompletion } from "./agent-account-types";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export type LoopbackCallback = { protocol: "http:"; hostname: string; port: string; pathname: string };

function loopback(url: URL): LoopbackCallback | null {
  if (url.protocol !== "http:") return null;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
  if (url.username || url.password) return null;
  const port = url.port || "80";
  return { protocol: "http:", hostname: url.hostname, port, pathname: url.pathname || "/" };
}

/** The loopback callback an authorize URL names in its `redirect_uri`, if any. */
export function loopbackRedirectOf(authorizeUrl: string): LoopbackCallback | null {
  let url: URL;
  try {
    url = new URL(authorizeUrl);
  } catch {
    return null;
  }
  const redirect = url.searchParams.get("redirect_uri");
  if (!redirect) return null;
  try {
    return loopback(new URL(redirect));
  } catch {
    return null;
  }
}

/**
 * How the user finishes a login the agent started.
 * - The agent asked for a code back: `code`.
 * - The agent waits on its own, and the URL sends the browser to a loopback
 *   listener: `redirect` (paste the address you land on).
 * - The agent waits on its own otherwise: `device` (approve on the provider's
 *   site; nothing to paste).
 */
export function classifyCompletion(authorizeUrl: string, mode: "auto" | "code"): { completion: AccountCompletion; callback: LoopbackCallback | null } {
  if (mode === "code") return { completion: "code", callback: null };
  const callback = loopbackRedirectOf(authorizeUrl);
  return callback ? { completion: "redirect", callback } : { completion: "device", callback: null };
}

export class RedirectRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedirectRefusedError";
  }
}

/**
 * The address to request on the Hub machine, or a refusal. Accepted only when
 * it is `http:` on a loopback host with the recorded callback's port and path.
 * The host may be any loopback spelling (a browser may show `127.0.0.1` for a
 * `localhost` redirect), but it is always requested on the recorded host. The
 * refusal message never repeats the pasted address.
 */
export function confineRedirect(pasted: string, callback: LoopbackCallback): URL {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new RedirectRefusedError("That is not a web address. Paste the whole address from the browser's address bar.");
  }
  const candidate = loopback(url);
  if (!candidate) throw new RedirectRefusedError("That address is not this login's local callback.");
  if (candidate.port !== callback.port || candidate.pathname !== callback.pathname) {
    throw new RedirectRefusedError("That address is not this login's local callback.");
  }
  const target = new URL(`${callback.protocol}//${callback.hostname}:${callback.port}${callback.pathname}`);
  target.search = url.search;
  return target;
}

export type RedirectFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Requests a confined address once: no redirects followed, a bounded wait, and
 * the body discarded. Whether the login completed is read from the attempt,
 * not from this response.
 */
export async function deliverRedirect(target: URL, fetch: RedirectFetch, timeoutMs = 10_000): Promise<void> {
  const response = await fetch(target.toString(), { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  await response.body?.cancel().catch(() => undefined);
}
