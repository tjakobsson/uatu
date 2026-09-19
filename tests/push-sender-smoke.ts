// Compile this entry to exercise Web Push's crypto dependency in a Bun binary.
import { createECDH, randomBytes } from "node:crypto";
import { createPushSender, generateVAPIDKeys } from "../src/hub/push-sender";

const receiver = createECDH("prime256v1");
receiver.generateKeys();
let checked = false;
const sender = createPushSender({
  keys: generateVAPIDKeys(),
  contact: "mailto:smoke@example.com",
  fetcher: (async (_url, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.get("authorization")?.startsWith("vapid t=") || headers.get("content-encoding") !== "aes128gcm"
      || !(init?.body instanceof Uint8Array) || init.body.byteLength < 100) throw new Error("invalid encrypted push request");
    checked = true;
    return new Response(null, { status: 201 });
  }),
});
const result = await sender({
  endpoint: "https://web.push.apple.com/smoke",
  keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
}, JSON.stringify({ body: "Agent turn finished" }), 300);
if (result.kind !== "accepted" || !checked) throw new Error("compiled Web Push smoke failed");
console.log("compiled Web Push crypto and transport smoke passed");
