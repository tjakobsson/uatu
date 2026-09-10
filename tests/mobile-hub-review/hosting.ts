/** Test-only: exact tailnet origin, never proxy trust or a configurable bind. */
export function validatePublicOrigin(value?: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > 253 || !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net:[0-9]{1,5}$/.test(value)) throw new Error("Review origin must be an exact tailnet HTTPS origin with dedicated port, no path");
  const url = new URL(value);
  if (url.origin !== value || ["", "443", "8443", "8444", "0"].includes(url.port)) throw new Error("Reserved or noncanonical review HTTPS port");
  return value;
}

export function reviewHostingOptions(args: string[], env: Record<string, string | undefined> = process.env) {
  let port = env.UATU_MOBILE_REVIEW_PORT ?? "4703";
  let publicOrigin = env.UATU_MOBILE_REVIEW_PUBLIC_ORIGIN;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !["--port", "--public-origin"].includes(key) || seen.has(key) || !value) throw new Error("Usage: bun tests/mobile-hub-review/server.ts [--port 4703] [--public-origin https://machine.tailnet.ts.net:8445]");
    seen.add(key);
    if (key === "--port") port = value; else publicOrigin = value;
  }
  if (!/^\d+$/.test(port) || Number(port) > 65535 || [4700, 4701, 4702].includes(Number(port))) throw new Error("Invalid or reserved review backend port");
  return { port: Number(port), publicOrigin: validatePublicOrigin(publicOrigin) };
}

export function reviewRequestAllowed(request: Request, port: number, publicOrigin?: string): boolean {
  const url = new URL(request.url), loopback = `http://127.0.0.1:${port}`;
  // Tailscale must preserve Host; Forwarded and X-Forwarded-* are never read.
  const host = request.headers.get("host");
  const origin = host === new URL(loopback).host ? loopback : publicOrigin && host === new URL(publicOrigin).host ? publicOrigin : undefined;
  return !!origin && url.host === host && (!request.headers.has("origin") || request.headers.get("origin") === origin) && request.headers.get("sec-fetch-site") !== "cross-site";
}
