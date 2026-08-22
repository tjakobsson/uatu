import { describe, expect, test } from "bun:test";

import {
  GIT_CREDENTIAL_INPUT_LIMIT,
  parseGitCredentialRequest,
  readBoundedCredentialInput,
  resolveGitCredential,
  runGitCredentialHelper,
} from "./git-credential-helper";
import type { TokenCredentialRecord } from "./credential-types";

const TOKEN = "sentinel-provider-token";
const CREDENTIAL: TokenCredentialRecord = {
  id: "token-1",
  name: "GitHub",
  type: "token",
  capabilities: ["https-git", "github-cli"],
  enabled: true,
  createdAt: "2026-08-20T12:00:00Z",
  metadata: { host: "github.com", username: "x-access-token" },
};

async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield new TextEncoder().encode(value);
}

describe("internal Git credential helper", () => {
  test("reads the standard protocol and emits a credential only for an exact HTTPS host match", async () => {
    const matching = await runGitCredentialHelper("get", chunks("protocol=https\nho", "st=GitHub.COM\n\n"), request => (
      resolveGitCredential(request, CREDENTIAL, TOKEN)
    ));
    expect(matching).toBe(`username=x-access-token\npassword=${TOKEN}\n\n`);

    for (const input of [
      "protocol=https\nhost=github.example\n\n",
      "protocol=http\nhost=github.com\n\n",
      "protocol=https\nhost=github.com@example.test\n\n",
      "protocol=https\nhost=github.com/path\n\n",
    ]) {
      const output = await runGitCredentialHelper("get", chunks(input), request => resolveGitCredential(request, CREDENTIAL, TOKEN));
      expect(output).toBe("");
      expect(output).not.toContain(TOKEN);
    }
    expect(await runGitCredentialHelper("store", chunks(`password=${TOKEN}\n\n`), () => {
      throw new Error("store must not resolve credentials");
    })).toBe("");
  });

  test("bounds stdin before parsing and rejects malformed input without including it in the error", async () => {
    await expect(readBoundedCredentialInput(chunks("x".repeat(GIT_CREDENTIAL_INPUT_LIMIT + 1))))
      .rejects.toThrow("credential input exceeds the size limit");
    expect(() => parseGitCredentialRequest(`protocol=https\n${TOKEN}\n`)).toThrow("invalid credential input");
    try {
      parseGitCredentialRequest(`protocol=https\n${TOKEN}\n`);
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN);
    }
  });

  test("declines disabled credentials and credentials without HTTPS Git capability", () => {
    expect(resolveGitCredential({ protocol: "https", host: "github.com" }, { ...CREDENTIAL, enabled: false }, TOKEN)).toBeUndefined();
    expect(resolveGitCredential({ protocol: "https", host: "github.com" }, {
      ...CREDENTIAL,
      capabilities: ["github-cli"],
    }, TOKEN)).toBeUndefined();
  });
});
