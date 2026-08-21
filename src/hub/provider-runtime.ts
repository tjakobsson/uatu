import { promises as fs } from "node:fs";
import path from "node:path";

import type { PublicToolReadinessDto, TokenCredentialRecord } from "./credential-types";

export type Provider = "github" | "gitlab";

export type ProviderRuntime = {
  provider: Provider;
  configDir: string;
  env: Record<string, string>;
};

export type ProviderCliSupport = {
  provider: Provider;
  status: "supported" | "missing" | "unsupported";
  version: string | null;
};

const MINIMUM_VERSION: Record<Provider, [number, number]> = {
  github: [2, 0],
  gitlab: [1, 22],
};

function parseVersion(value: string | null): [number, number] | undefined {
  const match = value?.match(/(?:^|\s)v?(\d+)\.(\d+)(?:\.\d+)?(?:\s|$)/);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

export function providerCliSupport(provider: Provider, readiness: PublicToolReadinessDto | undefined): ProviderCliSupport {
  if (!readiness?.path) return { provider, status: "missing", version: null };
  const version = parseVersion(readiness.version);
  const minimum = MINIMUM_VERSION[provider];
  const supported = version !== undefined && (version[0] > minimum[0] || (version[0] === minimum[0] && version[1] >= minimum[1]));
  return { provider, status: supported ? "supported" : "unsupported", version: readiness.version };
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function createProviderRuntime(
  provider: Provider,
  runtimeRoot: string,
  repositoryRoot: string,
  credential: TokenCredentialRecord,
  token: string,
): Promise<ProviderRuntime> {
  const capability = provider === "github" ? "github-cli" : "gitlab-cli";
  if (!credential.enabled || !credential.capabilities.includes(capability)) {
    throw new Error(`credential does not support the ${provider} CLI`);
  }
  const configDir = path.join(runtimeRoot, provider, credential.id);
  if (inside(repositoryRoot, configDir)) throw new Error("provider configuration must be outside the repository");
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fs.chmod(configDir, 0o700);

  const config = provider === "github"
    ? { git_protocol: "https" }
    : { hosts: { [credential.metadata.host]: { api_host: credential.metadata.host, git_protocol: "https" } } };
  const configPath = path.join(configDir, "config.yml");
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(configPath, 0o600);

  return provider === "github"
    ? {
        provider,
        configDir,
        env: { GH_CONFIG_DIR: configDir, GH_HOST: credential.metadata.host, GH_TOKEN: token },
      }
    : {
        provider,
        configDir,
        env: { GLAB_CONFIG_DIR: configDir, GITLAB_HOST: credential.metadata.host, GITLAB_TOKEN: token },
      };
}
