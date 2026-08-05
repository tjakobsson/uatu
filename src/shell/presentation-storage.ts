import { appBasePath } from "../shared/app-url";

export function presentationStorage(storage: Storage, basePath = appBasePath()): Storage {
  const prefix = `uatu:presentation:v1:${encodeURIComponent(basePath)}:`;
  const scopedKeys = (): string[] => {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) keys.push(key.slice(prefix.length));
    }
    return keys;
  };
  return {
    get length() { return scopedKeys().length; },
    clear() { for (const key of scopedKeys()) storage.removeItem(prefix + key); },
    getItem(key: string) { return storage.getItem(prefix + key); },
    key(index: number) { return scopedKeys()[index] ?? null; },
    removeItem(key: string) { storage.removeItem(prefix + key); },
    setItem(key: string, value: string) { storage.setItem(prefix + key, value); },
  };
}

export function presentationLocalStorage(): Storage | null {
  try {
    return presentationStorage(window.localStorage);
  } catch {
    return null;
  }
}

export function presentationSessionStorage(): Storage | null {
  try {
    return presentationStorage(window.sessionStorage);
  } catch {
    return null;
  }
}
