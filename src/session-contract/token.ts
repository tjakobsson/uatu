// Session contract: the session token. A workspace session mints one when it
// assembles its server and prints it on the ready line; the Hub holds it and
// applies it to every request it sends, so it never reaches a browser.

// 32 random bytes, base64url (43 characters, no padding).
export function mintSessionToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}
