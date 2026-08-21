import { describe, expect, test } from "bun:test";

import {
  type CredentialRecord,
  normalizeProviderHost,
  parseCredentialAssignment,
  parseCredentialRecord,
  parseCredentialState,
  parseCredentialToolState,
  parsePublicCredentialDto,
  parsePublicToolReadinessDto,
  type ReadinessResult,
  toPublicCredentialDto,
} from "./credential-types";

const SSH_CREDENTIAL: CredentialRecord = {
  id: "ssh-1",
  name: "GitHub SSH",
  type: "ssh",
  capabilities: ["ssh-authentication", "ssh-signing"],
  enabled: true,
  createdAt: "2026-08-20T12:00:00.000Z",
  metadata: {
    publicKey: "ssh-ed25519 AAAA example",
    fingerprint: "SHA256:example",
  },
};

describe("provider host normalization", () => {
  test("accepts only literal DNS names and IP addresses — never OpenSSH pattern metacharacters", () => {
    expect(normalizeProviderHost("GitHub.COM.")).toBe("github.com");
    expect(normalizeProviderHost("git.example.com:2222")).toBe("git.example.com:2222");
    expect(normalizeProviderHost("192.0.2.7")).toBe("192.0.2.7");
    expect(normalizeProviderHost("[2001:db8::1]")).toBe("[2001:db8::1]");
    // An explicit :443 survives normalization: an SSH assignment for that
    // port must not widen into a broad host match.
    expect(normalizeProviderHost("ssh.example.com:443")).toBe("ssh.example.com:443");
    expect(normalizeProviderHost("ssh.example.com.:0443")).toBe("ssh.example.com:443");
    expect(normalizeProviderHost("https://ssh.example.com:443/")).toBe("ssh.example.com:443");
    expect(normalizeProviderHost("ssh.example.com")).toBe("ssh.example.com");
    // `Host *` in generated SSH configuration would apply the credential to
    // every destination.
    for (const host of ["*", "*.example.com", "git?example.com", "github.com*"]) {
      expect(() => normalizeProviderHost(host)).toThrow(/DNS name or IP address|HTTPS host/);
    }
  });
});

describe("credential state validation", () => {
  test("parses each credential type and assignment role", () => {
    expect(parseCredentialRecord(SSH_CREDENTIAL)).toEqual(SSH_CREDENTIAL);
    expect(parseCredentialRecord({
      id: "pgp-1",
      name: "Release signing",
      type: "openpgp",
      capabilities: ["openpgp-signing"],
      enabled: false,
      createdAt: "2026-08-20T12:00:00Z",
      metadata: { publicKey: "-----BEGIN PGP PUBLIC KEY BLOCK-----", fingerprint: "0123456789ABCDEF" },
    }).type).toBe("openpgp");
    expect(parseCredentialRecord({
      id: "token-1",
      name: "GitLab token",
      type: "token",
      capabilities: ["https-git", "gitlab-cli"],
      enabled: true,
      createdAt: "2026-08-20T12:00:00Z",
      metadata: { host: "gitlab.com", username: "oauth2" },
    }).type).toBe("token");
    expect(parseCredentialAssignment({
      workspaceId: "uatu",
      credentialId: "ssh-1",
      role: "authentication",
      host: "github.com",
    }).role).toBe("authentication");
    expect(parseCredentialAssignment({
      workspaceId: "uatu",
      credentialId: "ssh-1",
      role: "signing",
    }).role).toBe("signing");
  });

  test("rejects unknown fields, invalid capability combinations, and duplicates", () => {
    expect(() => parseCredentialRecord({ ...SSH_CREDENTIAL, privateKey: "secret" })).toThrow(/unknown.*privateKey/);
    expect(() => parseCredentialRecord({
      ...SSH_CREDENTIAL,
      metadata: { ...SSH_CREDENTIAL.metadata, secretPath: "/secret" },
    })).toThrow(/unknown.*secretPath/);
    expect(() => parseCredentialRecord({ ...SSH_CREDENTIAL, capabilities: ["https-git"] })).toThrow(/capabilities/);
    expect(() => parseCredentialRecord({ ...SSH_CREDENTIAL, capabilities: ["ssh-signing", "ssh-signing"] })).toThrow(/duplicates/);
    expect(() => parseCredentialState({
      version: 1,
      credentials: [SSH_CREDENTIAL, SSH_CREDENTIAL],
      assignments: [],
    })).toThrow(/ids must be unique/);
    expect(() => parseCredentialState({ version: 1, credentials: [], assignments: [], token: "secret" })).toThrow(/unknown.*token/);
  });

  test("parses a closed versioned tool override state", () => {
    expect(parseCredentialToolState({
      version: 1,
      overrides: [{ tool: "gpg", path: "/opt/bin/gpg" }],
    })).toEqual({ version: 1, overrides: [{ tool: "gpg", path: "/opt/bin/gpg" }] });
    expect(() => parseCredentialToolState({
      version: 1,
      overrides: [{ tool: "gpg", path: "bin/gpg" }],
    })).toThrow(/absolute/);
    expect(() => parseCredentialToolState({
      version: 1,
      overrides: [{ tool: "gpg", path: "/one" }, { tool: "gpg", path: "/two" }],
    })).toThrow(/unique/);
  });
});

describe("public credential DTO validation", () => {
  const readiness: ReadinessResult[] = [{ layer: "binary", status: "ready", message: "OpenSSH found" }];

  test("constructs only explicit public fields", () => {
    const dto = toPublicCredentialDto(
      parseCredentialRecord(SSH_CREDENTIAL),
      [{ workspaceId: "uatu", credentialId: "ssh-1", role: "signing" }],
      readiness,
    );
    expect(dto).toEqual({
      ...SSH_CREDENTIAL,
      assignments: [{ workspaceId: "uatu", credentialId: "ssh-1", role: "signing" }],
      readiness,
    });
  });

  test.each(["token", "passphrase", "privateKey", "secret", "secretPath", "agentSocket"])(
    "rejects secret-bearing public field %s",
    field => {
      expect(() => parsePublicCredentialDto({
        ...SSH_CREDENTIAL,
        assignments: [],
        readiness,
        [field]: "sentinel-secret",
      })).toThrow(new RegExp(`unknown.*${field}`));
    },
  );

  test("rejects unknown nested public fields", () => {
    expect(() => parsePublicCredentialDto({
      ...SSH_CREDENTIAL,
      assignments: [],
      readiness: [{ ...readiness[0], stderr: "sentinel-secret" }],
    })).toThrow(/unknown.*stderr/);
    expect(() => parsePublicToolReadinessDto({
      tool: "gpg",
      path: "/usr/bin/gpg",
      version: "2.4.0",
      results: readiness,
      guidance: null,
      environment: "sentinel-secret",
    })).toThrow(/unknown.*environment/);
  });
});
