import { appBasePath } from "../shared/app-url";

// Some browsers expose `window.localStorage` but throw from its *methods* when
// storage is denied (blocked cookies, Safari private mode, quota exhaustion).
// Guarding only the getter therefore leaves every caller unprotected, so each
// operation below degrades to a client-local map instead of propagating.
//
// The fallback is shared per underlying storage object + workspace prefix so
// that repeated `presentationLocalStorage()` calls in different modules keep
// observing the same workspace-scoped values within a document.
const fallbacks = new WeakMap<Storage, Map<string, Map<string, string>>>();

function fallbackFor(storage: Storage, prefix: string): Map<string, string> {
  let byPrefix = fallbacks.get(storage);
  if (!byPrefix) {
    byPrefix = new Map();
    fallbacks.set(storage, byPrefix);
  }
  let values = byPrefix.get(prefix);
  if (!values) {
    values = new Map();
    byPrefix.set(prefix, values);
  }
  return values;
}

export function presentationStorage(storage: Storage, basePath = appBasePath()): Storage {
  const prefix = `uatu:presentation:v1:${encodeURIComponent(basePath)}:`;
  const local = () => fallbackFor(storage, prefix);

  // Keys may live in the real store, in the fallback, or be split across both
  // when only some operations are denied, so enumeration unions the two.
  const scopedKeys = (): string[] => {
    const keys: string[] = [];
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(prefix)) keys.push(key.slice(prefix.length));
      }
    } catch { /* denied */ }
    for (const key of local().keys()) {
      if (!keys.includes(key)) keys.push(key);
    }
    return keys;
  };

  return {
    get length() { return scopedKeys().length; },
    clear() {
      for (const key of scopedKeys()) {
        try { storage.removeItem(prefix + key); } catch { /* denied */ }
      }
      local().clear();
    },
    getItem(key: string) {
      // The fallback only ever holds a value whose durable write was denied,
      // and a successful write clears it, so its presence means it is fresher
      // than whatever the real store still has. Consult it first, or an
      // over-quota update silently reverts to the stale persisted value.
      const fallback = local();
      if (fallback.has(key)) return fallback.get(key)!;
      try {
        return storage.getItem(prefix + key);
      } catch {
        return null;
      }
    },
    key(index: number) { return scopedKeys()[index] ?? null; },
    removeItem(key: string) {
      try { storage.removeItem(prefix + key); } catch { /* denied */ }
      local().delete(key);
    },
    setItem(key: string, value: string) {
      try {
        storage.setItem(prefix + key, value);
        // The durable write is authoritative; drop any shadowing fallback.
        local().delete(key);
      } catch {
        local().set(key, value);
      }
    },
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
