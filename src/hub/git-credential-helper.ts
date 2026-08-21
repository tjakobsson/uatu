import { CredentialMetadataStore, CredentialTokenStore } from "./credential-store";
import { normalizeProviderHost, type TokenCredentialRecord } from "./credential-types";
import { credentialsPath, credentialTokenStorePath } from "./state-dir";

export const GIT_CREDENTIAL_INPUT_LIMIT = 16 * 1024;

export type GitCredentialRequest = {
  protocol?: string;
  host?: string;
};

export type GitCredential = {
  username: string;
  password: string;
};

export async function readBoundedCredentialInput(
  input: AsyncIterable<Uint8Array | string>,
  limit = GIT_CREDENTIAL_INPUT_LIMIT,
): Promise<string> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  for await (const chunk of input) {
    const encoded = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    bytes += encoded.byteLength;
    if (bytes > limit) throw new Error("credential input exceeds the size limit");
    result += decoder.decode(encoded, { stream: true });
  }
  result += decoder.decode();
  return result;
}

export function parseGitCredentialRequest(input: string): GitCredentialRequest {
  if (input.includes("\0") || Buffer.byteLength(input) > GIT_CREDENTIAL_INPUT_LIMIT) {
    throw new Error("invalid credential input");
  }
  const request: GitCredentialRequest = {};
  for (const line of input.split(/\r?\n/)) {
    if (line === "") break;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("invalid credential input");
    const key = line.slice(0, separator);
    if (key === "protocol" || key === "host") request[key] = line.slice(separator + 1);
  }
  return request;
}

export function resolveGitCredential(
  request: GitCredentialRequest,
  expected: TokenCredentialRecord,
  token: string,
): GitCredential | undefined {
  if (!expected.enabled || !expected.capabilities.includes("https-git") || request.protocol !== "https" || !request.host) {
    return undefined;
  }
  let requestedHost: string;
  try {
    if (request.host.includes("://") || request.host.includes("/") || request.host.includes("@")) return undefined;
    requestedHost = normalizeProviderHost(request.host);
  } catch {
    return undefined;
  }
  if (requestedHost !== expected.metadata.host) return undefined;
  return { username: expected.metadata.username ?? "oauth2", password: token };
}

export function formatGitCredential(credential: GitCredential | undefined): string {
  return credential ? `username=${credential.username}\npassword=${credential.password}\n\n` : "";
}

export async function runGitCredentialHelper(
  action: string | undefined,
  input: AsyncIterable<Uint8Array | string>,
  lookup: (request: GitCredentialRequest) => Promise<GitCredential | undefined> | GitCredential | undefined,
): Promise<string> {
  if (action !== "get") return "";
  const request = parseGitCredentialRequest(await readBoundedCredentialInput(input));
  return formatGitCredential(await lookup(request));
}

export async function runStoredGitCredentialHelper(
  action: string | undefined,
  input: AsyncIterable<Uint8Array | string>,
  env: Record<string, string | undefined>,
): Promise<string> {
  const stateRoot = env.UATU_HUB_STATE_ROOT;
  const credentialId = env.UATU_CREDENTIAL_ID;
  if (!stateRoot || !credentialId) return "";
  const metadata = new CredentialMetadataStore(credentialsPath(stateRoot));
  const secrets = new CredentialTokenStore(credentialTokenStorePath(stateRoot));
  await Promise.all([metadata.load(), secrets.load()]);
  return runGitCredentialHelper(action, input, request => {
    const credential = metadata.snapshot().credentials.find(item => item.id === credentialId);
    const token = secrets.get(credentialId);
    if (!credential || credential.type !== "token" || token === undefined) return undefined;
    return resolveGitCredential(request, credential, token);
  });
}
