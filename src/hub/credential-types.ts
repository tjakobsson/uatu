export const CREDENTIAL_STATE_VERSION = 1 as const;
export const CREDENTIAL_TOOL_STATE_VERSION = 1 as const;

export const CREDENTIAL_TYPES = ["ssh", "openpgp", "token"] as const;
export type CredentialType = typeof CREDENTIAL_TYPES[number];

export const CREDENTIAL_CAPABILITIES = [
  "ssh-authentication",
  "ssh-signing",
  "openpgp-signing",
  "https-git",
  "github-cli",
  "gitlab-cli",
] as const;
export type CredentialCapability = typeof CREDENTIAL_CAPABILITIES[number];

export const CREDENTIAL_TOOLS = [
  "ssh",
  "ssh-agent",
  "ssh-add",
  "ssh-keygen",
  "gpg",
  "gpgconf",
  "git",
  "gh",
  "glab",
] as const;
export type CredentialTool = typeof CREDENTIAL_TOOLS[number];

export type SshCredentialMetadata = {
  publicKey: string;
  fingerprint: string;
};

export type OpenPgpCredentialMetadata = {
  publicKey: string;
  fingerprint: string;
};

export type TokenCredentialMetadata = {
  host: string;
  username?: string;
};

type CredentialBase = {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: string;
};

export type SshCredentialRecord = CredentialBase & {
  type: "ssh";
  capabilities: Array<"ssh-authentication" | "ssh-signing">;
  metadata: SshCredentialMetadata;
};

export type OpenPgpCredentialRecord = CredentialBase & {
  type: "openpgp";
  capabilities: ["openpgp-signing"];
  metadata: OpenPgpCredentialMetadata;
};

export type TokenCredentialRecord = CredentialBase & {
  type: "token";
  capabilities: Array<"https-git" | "github-cli" | "gitlab-cli">;
  metadata: TokenCredentialMetadata;
};

export type CredentialRecord = SshCredentialRecord | OpenPgpCredentialRecord | TokenCredentialRecord;

export type NewCredential =
  | Omit<SshCredentialRecord, "id" | "createdAt">
  | Omit<OpenPgpCredentialRecord, "id" | "createdAt">
  | Omit<TokenCredentialRecord, "id" | "createdAt">;

export type AuthenticationCredentialAssignment = {
  workspaceId: string;
  credentialId: string;
  role: "authentication";
  host: string;
};

export type SigningCredentialAssignment = {
  workspaceId: string;
  credentialId: string;
  role: "signing";
};

export type CredentialAssignment = AuthenticationCredentialAssignment | SigningCredentialAssignment;

export type CredentialState = {
  version: typeof CREDENTIAL_STATE_VERSION;
  credentials: CredentialRecord[];
  assignments: CredentialAssignment[];
};

export type CredentialToolOverride = {
  tool: CredentialTool;
  path: string;
};

export type CredentialToolState = {
  version: typeof CREDENTIAL_TOOL_STATE_VERSION;
  overrides: CredentialToolOverride[];
};

export const READINESS_LAYERS = ["binary", "version", "runtime", "credential", "capability"] as const;
export type ReadinessLayer = typeof READINESS_LAYERS[number];
export const READINESS_STATUSES = ["ready", "unavailable", "not-applicable"] as const;
export type ReadinessStatus = typeof READINESS_STATUSES[number];

export type ReadinessResult = {
  layer: ReadinessLayer;
  status: ReadinessStatus;
  message: string;
};

export type PublicToolReadinessDto = {
  tool: CredentialTool;
  path: string | null;
  version: string | null;
  results: ReadinessResult[];
  guidance: string | null;
};

export type PublicCredentialDto = CredentialRecord & {
  assignments: CredentialAssignment[];
  readiness: ReadinessResult[];
};

type RecordValue = Record<string, unknown>;

function record(value: unknown, context: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as RecordValue;
}

function keys(value: RecordValue, allowed: readonly string[], context: string): void {
  const allowedFields = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) throw new Error(`unknown ${context} field: ${key}`);
  }
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, context: string): string | undefined {
  return value === undefined ? undefined : string(value, context);
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${context} must be a boolean`);
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T, context: string): T[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new Error(`invalid ${context}`);
  }
  return value as T[number];
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value;
}

function uniqueValues<const T extends readonly string[]>(value: unknown, values: T, context: string): T[number][] {
  const parsed = array(value, context).map(item => oneOf(item, values, context));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${context} must not contain duplicates`);
  return parsed;
}

function timestamp(value: unknown, context: string): string {
  const parsed = string(value, context);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(parsed) || Number.isNaN(Date.parse(parsed))) {
    throw new Error(`${context} must be an ISO 8601 timestamp`);
  }
  return parsed;
}

export function normalizeProviderHost(value: string): string {
  if (value.trim() !== value || value === "" || value.includes("\0") || /\s/.test(value)) {
    throw new Error("provider host must be a non-empty host");
  }
  const hasScheme = value.includes("://");
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? value : `https://${value}`);
  } catch {
    throw new Error("provider host is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("provider host must identify an HTTPS host");
  }
  if (parsed.pathname !== "/") throw new Error("provider host must not contain a path");
  const hostname = parsed.hostname.endsWith(".") ? parsed.hostname.slice(0, -1) : parsed.hostname;
  if (!hostname) throw new Error("provider host is invalid");
  const lower = hostname.toLowerCase();
  // Generated OpenSSH configuration matches on this value, so it must be a
  // literal DNS name or IP address: the URL parser preserves OpenSSH pattern
  // metacharacters, and a host of `*` would emit `Host *` and apply the
  // credential to every SSH destination.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(lower) && !/^\[[0-9a-f:.]+\]$/.test(lower)) {
    throw new Error("provider host must be a DNS name or IP address");
  }
  // The URL parser erases an explicitly supplied default port, but an SSH
  // assignment for example.com:443 must stay restricted to port 443 — a
  // broad host match would offer the key on every port.
  const authority = (hasScheme ? value.slice(value.indexOf("://") + 3) : value).replace(/[/?#].*$/, "");
  const explicitDefaultPort = /:0*443$/.test(authority);
  const port = parsed.port || (explicitDefaultPort ? "443" : "");
  return `${lower}${port ? `:${port}` : ""}`;
}

function normalizedHost(value: unknown, context: string): string {
  const parsed = string(value, context);
  let normalized: string;
  try {
    normalized = normalizeProviderHost(parsed);
  } catch {
    throw new Error(`${context} must be a normalized provider host`);
  }
  if (parsed !== normalized) {
    throw new Error(`${context} must be a normalized provider host`);
  }
  return parsed;
}

function parseSshMetadata(value: unknown): SshCredentialMetadata {
  const parsed = record(value, "SSH credential metadata");
  keys(parsed, ["publicKey", "fingerprint"], "SSH credential metadata");
  return {
    publicKey: string(parsed.publicKey, "SSH public key"),
    fingerprint: string(parsed.fingerprint, "SSH fingerprint"),
  };
}

function parseOpenPgpMetadata(value: unknown): OpenPgpCredentialMetadata {
  const parsed = record(value, "OpenPGP credential metadata");
  keys(parsed, ["publicKey", "fingerprint"], "OpenPGP credential metadata");
  return {
    publicKey: string(parsed.publicKey, "OpenPGP public key"),
    fingerprint: string(parsed.fingerprint, "OpenPGP fingerprint"),
  };
}

function parseTokenMetadata(value: unknown): TokenCredentialMetadata {
  const parsed = record(value, "token credential metadata");
  keys(parsed, ["host", "username"], "token credential metadata");
  const username = optionalString(parsed.username, "token username");
  if (username !== undefined && /[\r\n]/.test(username)) throw new Error("token username must be one protocol line");
  return {
    host: normalizedHost(parsed.host, "token host"),
    ...(username === undefined ? {} : { username }),
  };
}

export function parseCredentialRecord(value: unknown): CredentialRecord {
  const parsed = record(value, "credential");
  keys(parsed, ["id", "name", "type", "capabilities", "enabled", "createdAt", "metadata"], "credential");
  const base = {
    id: string(parsed.id, "credential id"),
    name: string(parsed.name, "credential name"),
    enabled: boolean(parsed.enabled, "credential enabled"),
    createdAt: timestamp(parsed.createdAt, "credential createdAt"),
  };
  const type = oneOf(parsed.type, CREDENTIAL_TYPES, "credential type");
  if (type === "ssh") {
    const capabilities = uniqueValues(parsed.capabilities, ["ssh-authentication", "ssh-signing"] as const, "SSH capabilities");
    if (capabilities.length === 0) throw new Error("SSH credential must declare a capability");
    return { ...base, type, capabilities, metadata: parseSshMetadata(parsed.metadata) };
  }
  if (type === "openpgp") {
    const capabilities = uniqueValues(parsed.capabilities, ["openpgp-signing"] as const, "OpenPGP capabilities");
    if (capabilities.length !== 1) throw new Error("OpenPGP credential must declare signing");
    return { ...base, type, capabilities: ["openpgp-signing"], metadata: parseOpenPgpMetadata(parsed.metadata) };
  }
  const capabilities = uniqueValues(parsed.capabilities, ["https-git", "github-cli", "gitlab-cli"] as const, "token capabilities");
  if (capabilities.length === 0) throw new Error("token credential must declare a capability");
  if (capabilities.includes("github-cli") && capabilities.includes("gitlab-cli")) {
    throw new Error("token credential cannot declare both provider CLI capabilities");
  }
  return { ...base, type, capabilities, metadata: parseTokenMetadata(parsed.metadata) };
}

export function parseCredentialAssignment(value: unknown): CredentialAssignment {
  const parsed = record(value, "credential assignment");
  const role = oneOf(parsed.role, ["authentication", "signing"] as const, "credential assignment role");
  if (role === "authentication") {
    keys(parsed, ["workspaceId", "credentialId", "role", "host"], "authentication assignment");
    return {
      workspaceId: string(parsed.workspaceId, "assignment workspaceId"),
      credentialId: string(parsed.credentialId, "assignment credentialId"),
      role,
      host: normalizedHost(parsed.host, "assignment host"),
    };
  }
  keys(parsed, ["workspaceId", "credentialId", "role"], "signing assignment");
  return {
    workspaceId: string(parsed.workspaceId, "assignment workspaceId"),
    credentialId: string(parsed.credentialId, "assignment credentialId"),
    role,
  };
}

export function parseCredentialState(value: unknown): CredentialState {
  const parsed = record(value, "credential state");
  keys(parsed, ["version", "credentials", "assignments"], "credential state");
  if (parsed.version !== CREDENTIAL_STATE_VERSION) throw new Error("unsupported credential state version");
  const credentials = array(parsed.credentials, "credentials").map(parseCredentialRecord);
  if (new Set(credentials.map(item => item.id)).size !== credentials.length) {
    throw new Error("credential ids must be unique");
  }
  const assignments = array(parsed.assignments, "credential assignments").map(parseCredentialAssignment);
  return { version: CREDENTIAL_STATE_VERSION, credentials, assignments };
}

export function parseCredentialToolOverride(value: unknown): CredentialToolOverride {
  const parsed = record(value, "credential tool override");
  keys(parsed, ["tool", "path"], "credential tool override");
  const overridePath = string(parsed.path, "credential tool path");
  if (!overridePath.startsWith("/")) throw new Error("credential tool path must be absolute");
  return { tool: oneOf(parsed.tool, CREDENTIAL_TOOLS, "credential tool"), path: overridePath };
}

export function parseCredentialToolState(value: unknown): CredentialToolState {
  const parsed = record(value, "credential tool state");
  keys(parsed, ["version", "overrides"], "credential tool state");
  if (parsed.version !== CREDENTIAL_TOOL_STATE_VERSION) throw new Error("unsupported credential tool state version");
  const overrides = array(parsed.overrides, "credential tool overrides").map(parseCredentialToolOverride);
  if (new Set(overrides.map(item => item.tool)).size !== overrides.length) {
    throw new Error("credential tool overrides must be unique");
  }
  return { version: CREDENTIAL_TOOL_STATE_VERSION, overrides };
}

export function parseReadinessResult(value: unknown): ReadinessResult {
  const parsed = record(value, "readiness result");
  keys(parsed, ["layer", "status", "message"], "readiness result");
  return {
    layer: oneOf(parsed.layer, READINESS_LAYERS, "readiness layer"),
    status: oneOf(parsed.status, READINESS_STATUSES, "readiness status"),
    message: string(parsed.message, "readiness message"),
  };
}

export function parsePublicToolReadinessDto(value: unknown): PublicToolReadinessDto {
  const parsed = record(value, "public tool readiness");
  keys(parsed, ["tool", "path", "version", "results", "guidance"], "public tool readiness");
  for (const field of ["path", "version", "guidance"] as const) {
    if (parsed[field] !== null && typeof parsed[field] !== "string") {
      throw new Error(`public tool readiness ${field} must be a string or null`);
    }
  }
  return {
    tool: oneOf(parsed.tool, CREDENTIAL_TOOLS, "credential tool"),
    path: parsed.path as string | null,
    version: parsed.version as string | null,
    results: array(parsed.results, "readiness results").map(parseReadinessResult),
    guidance: parsed.guidance as string | null,
  };
}

export function parsePublicCredentialDto(value: unknown): PublicCredentialDto {
  const parsed = record(value, "public credential");
  keys(
    parsed,
    ["id", "name", "type", "capabilities", "enabled", "createdAt", "metadata", "assignments", "readiness"],
    "public credential",
  );
  const credential = parseCredentialRecord({
    id: parsed.id,
    name: parsed.name,
    type: parsed.type,
    capabilities: parsed.capabilities,
    enabled: parsed.enabled,
    createdAt: parsed.createdAt,
    metadata: parsed.metadata,
  });
  return {
    ...credential,
    assignments: array(parsed.assignments, "public credential assignments").map(parseCredentialAssignment),
    readiness: array(parsed.readiness, "public credential readiness").map(parseReadinessResult),
  };
}

export function toPublicCredentialDto(
  credential: CredentialRecord,
  assignments: CredentialAssignment[],
  readiness: ReadinessResult[],
): PublicCredentialDto {
  return parsePublicCredentialDto({
    id: credential.id,
    name: credential.name,
    type: credential.type,
    capabilities: [...credential.capabilities],
    enabled: credential.enabled,
    createdAt: credential.createdAt,
    metadata: { ...credential.metadata },
    assignments: assignments.map(assignment => ({ ...assignment })),
    readiness: readiness.map(result => ({ ...result })),
  });
}
