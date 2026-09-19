import { buildPushPayload } from "@block65/webcrypto-web-push";
import { createECDH, ECDH } from "node:crypto";

export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
export type VapidKeys = { publicKey: string; privateKey: string };
export type PushFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function generateVAPIDKeys(): VapidKeys {
  const key = createECDH("prime256v1");
  key.generateKeys();
  const privateKey = Buffer.from(key.getPrivateKey().toString("hex").padStart(64, "0"), "hex");
  return { publicKey: key.getPublicKey().toString("base64url"), privateKey: privateKey.toString("base64url") };
}

export type PushSendResult =
  | { kind: "accepted" }
  | { kind: "gone" }
  | { kind: "retry"; retryAfterMs?: number }
  | { kind: "configuration-error" };

export type PushSender = (subscription: PushSubscription, payload: string, ttlSeconds: number) => Promise<PushSendResult>;

// Browser-issued endpoints only. An enrollment must not turn the hub into an
// authenticated HTTP client for a caller-chosen LAN service or redirect target.
export function validPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
    return url.hostname === "fcm.googleapis.com"
      || url.hostname === "updates.push.services.mozilla.com"
      || url.hostname.endsWith(".push.apple.com")
      || url.hostname.endsWith(".notify.windows.com");
  } catch {
    return false;
  }
}

export function validPushContact(contact: string): boolean {
  try {
    const url = new URL(contact);
    return url.protocol === "mailto:" ? /^[^\s@]+@[^\s@]+$/.test(url.pathname)
      : url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function parsePushSubscription(value: unknown): PushSubscription | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { endpoint, keys } = value as Record<string, unknown>;
  if (typeof endpoint !== "string" || endpoint.length > 4096 || !validPushEndpoint(endpoint)
    || !keys || typeof keys !== "object" || Array.isArray(keys)) return null;
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== "string" || typeof auth !== "string"
    || !/^[\w-]{87}={0,2}$/.test(p256dh) || !/^[\w-]{22}={0,2}$/.test(auth)) return null;
  const publicKey = Buffer.from(p256dh, "base64url");
  if (publicKey.length !== 65 || publicKey[0] !== 4 || Buffer.from(auth, "base64url").length !== 16) return null;
  try { ECDH.convertKey(publicKey, "prime256v1"); } catch { return null; }
  return { endpoint, keys: { p256dh, auth } };
}

export function createPushSender(options: {
  keys: VapidKeys;
  contact: string;
  fetcher?: PushFetcher;
  now?: () => number;
}): PushSender {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  return async (subscription, payload, ttlSeconds) => {
    if (!validPushEndpoint(subscription.endpoint) || !validPushContact(options.contact)) return { kind: "configuration-error" };
    let details: Awaited<ReturnType<typeof buildPushPayload>>;
    try {
      details = await buildPushPayload({ data: payload, options: {
        ttl: Math.max(0, Math.min(300, Math.floor(ttlSeconds))), urgency: "normal",
      } }, { ...subscription, expirationTime: null }, { ...options.keys, subject: options.contact });
      // The dependency defaults a zero TTL to 60. Preserve caller expiry.
      details.headers.ttl = String(Math.max(0, Math.min(300, Math.floor(ttlSeconds))));
    } catch {
      return { kind: "configuration-error" };
    }
    try {
      const response = await fetcher(subscription.endpoint, {
        method: "POST",
        headers: details.headers,
        body: details.body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      // Bodies can contain the subscription endpoint. Neither retain nor log them.
      await response.body?.cancel();
      if (response.ok) return { kind: "accepted" };
      if (response.status === 404 || response.status === 410) return { kind: "gone" };
      if (response.status === 429 || response.status >= 500) {
        const value = response.headers.get("retry-after");
        const delay = value === null ? NaN : /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now();
        return { kind: "retry", ...(Number.isFinite(delay) ? { retryAfterMs: Math.max(0, Math.min(300_000, delay)) } : {}) };
      }
      return { kind: "configuration-error" };
    } catch {
      return { kind: "retry" };
    }
  };
}
