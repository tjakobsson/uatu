/**
 * Insert into a bounded map, evicting the stalest entry past the ceiling.
 *
 * Setting an existing key re-inserts it, so recency is refreshed on every
 * write — the entry that falls out is the one nothing has touched for
 * longest, never the one being actively updated. (A plain `map.set` keeps the
 * key's original position, which would evict a hot entry that happened to be
 * inserted first.)
 *
 * Returns the evicted key so a caller keeping bookkeeping beside the map can
 * drop its side of the evicted entry too.
 */
export function boundedSet<T>(map: Map<string, T>, key: string, value: T, limit: number): string | undefined {
  map.delete(key);
  map.set(key, value);
  if (map.size <= limit) return undefined;
  const oldest = map.keys().next().value!;
  map.delete(oldest);
  return oldest;
}
