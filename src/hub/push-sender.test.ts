import { describe, expect, test } from "bun:test";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { createPushSender, generateVAPIDKeys, parsePushSubscription, validPushContact, validPushEndpoint } from "./push-sender";

function device() {
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const auth = randomBytes(16);
  return { receiver, auth, subscription: {
    endpoint: "https://web.push.apple.com/test-subscription",
    keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
  } };
}

describe("Web Push sender", () => {
  test("sends a VAPID-authenticated payload the enrolled device can decrypt", async () => {
    const { receiver, auth, subscription } = device();
    const keys = generateVAPIDKeys();
    const payload = JSON.stringify({ id: "question:one", body: "An agent needs your answer" });
    const sender = createPushSender({ keys, contact: "mailto:operator@example.com", fetcher: (async (url, init) => {
      expect(url).toBe(subscription.endpoint);
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toStartWith("vapid t=");
      expect(headers.get("authorization")).toContain(`k=${keys.publicKey}`);
      expect(headers.get("ttl")).toBe("42");
      expect(headers.get("content-encoding")).toBe("aes128gcm");
      // Independently decode the RFC 8291 key schedule and RFC 8188 record.
      const body = Buffer.from(init?.body as Uint8Array);
      const salt = body.subarray(0, 16);
      const keyLength = body[20]!;
      const senderKey = body.subarray(21, 21 + keyLength);
      const info = Buffer.concat([Buffer.from("WebPush: info\0"), receiver.getPublicKey(), senderKey]);
      const ikm = hkdfSync("sha256", receiver.computeSecret(senderKey), auth, info, 32);
      const key = hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
      const nonce = hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
      const decipher = createDecipheriv("aes-128-gcm", Buffer.from(key), Buffer.from(nonce));
      decipher.setAuthTag(body.subarray(-16));
      const clear = Buffer.concat([decipher.update(body.subarray(21 + keyLength, -16)), decipher.final()]);
      let delimiter = clear.length - 1;
      while (clear[delimiter] === 0) delimiter -= 1;
      expect(clear.subarray(0, delimiter).toString()).toBe(payload);
      expect(clear[delimiter]).toBe(2);
      return new Response(null, { status: 201 });
    }) });
    expect(await sender(subscription, payload, 42)).toEqual({ kind: "accepted" });
  });

  test.each([
    [410, { kind: "gone" }], [404, { kind: "gone" }],
    [429, { kind: "retry", retryAfterMs: 2000 }], [503, { kind: "retry", retryAfterMs: 2000 }],
    [401, { kind: "configuration-error" }], [403, { kind: "configuration-error" }],
  ] as const)("classifies HTTP %s without retaining the response payload", async (status, result) => {
    const sender = createPushSender({ keys: generateVAPIDKeys(), contact: "https://example.com/contact", fetcher: (async () =>
      new Response("private endpoint", { status, headers: { "retry-after": "2" } })) });
    expect(await sender(device().subscription, "message", 300)).toEqual(result);
  });

  test("network errors retry and invalid configuration never makes a request", async () => {
    const subscription = device().subscription;
    const sender = createPushSender({ keys: generateVAPIDKeys(), contact: "mailto:operator@example.com", fetcher: (async () => { throw new Error(subscription.endpoint); }) });
    expect(await sender(subscription, "message", 300)).toEqual({ kind: "retry" });
    expect(await sender({ ...subscription, endpoint: "https://127.0.0.1/admin" }, "message", 300)).toEqual({ kind: "configuration-error" });
  });

  test("validates browser-issued subscriptions and contact settings", () => {
    const subscription = device().subscription;
    expect(parsePushSubscription(subscription)).toEqual(subscription);
    expect(parsePushSubscription({ ...subscription, keys: { ...subscription.keys, p256dh: "invalid" } })).toBeNull();
    for (const endpoint of ["http://web.push.apple.com/x", "https://web.push.apple.com.evil.test/x", "https://localhost/x", "https://user@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x"]) {
      expect(validPushEndpoint(endpoint)).toBe(false);
    }
    expect(validPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(true);
    expect(validPushContact("mailto:operator@example.com")).toBe(true);
    expect(validPushContact("http://localhost")).toBe(false);
  });
});
