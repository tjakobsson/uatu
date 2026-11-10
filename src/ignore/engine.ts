import path from "node:path";
import ignore from "ignore";
import { loadIgnoreConfig } from "./config";
import { shouldDenyPath } from "./exposure";

export type IgnoreMatcherOptions = {
  rootPath: string;
  respectGitignore: boolean;
  isSingleFileRoot?: boolean;
};

export type IgnoreMatcher = {
  shouldIgnore(relativePath: string, isDirectory?: boolean): boolean;
  isVisibilityException?(relativePath: string): boolean;
  initialShowIgnored?: boolean;
  explicitInitialShowIgnored?: boolean;
  toChokidarIgnored(): (testPath: string, stats?: { isDirectory(): boolean }) => boolean;
};

// Built-in exclusions (exposure.shouldDenyPath) win over everything; explicit
// positive `ignore.exclude` patterns come next. Nothing else is excluded:
// Git-ignore status is browsing visibility, not exposure.
export async function loadIgnoreMatcher(options: IgnoreMatcherOptions): Promise<IgnoreMatcher> {
  const { rootPath, respectGitignore, isSingleFileRoot = false } = options;
  const config = isSingleFileRoot ? null : (await loadIgnoreConfig(rootPath)).config;
  const positive = ignore().add(config?.exclude.filter(pattern => !pattern.startsWith("!")) ?? []);
  const exceptions = ignore().add(config?.exclude ?? []);
  const shouldIgnore = (relativePath: string, isDirectory = false): boolean => {
    if (!relativePath || relativePath === ".") return false;
    if (shouldDenyPath(relativePath)) return true;
    const test = isDirectory && !relativePath.endsWith("/") ? `${relativePath}/` : relativePath;
    return positive.ignores(test);
  };
  const explicit = !respectGitignore ? true : config?.explicitRespectGitignore === undefined ? undefined : !config.explicitRespectGitignore;
  return {
    shouldIgnore,
    initialShowIgnored: explicit ?? true,
    explicitInitialShowIgnored: explicit,
    isVisibilityException: relative => exceptions.test(relative).unignored,
    toChokidarIgnored: () => (testPath, stats) => {
      const relative = path.relative(rootPath, testPath);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
      return shouldIgnore(relative.split(path.sep).join("/"), stats?.isDirectory() ?? true);
    },
  };
}
