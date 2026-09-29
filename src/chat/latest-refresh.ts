// Overlapping refreshes of the same thing — a catalog read started by a
// slash query, then another after a reload — can answer out of order. Each
// refresh takes a ticket; only the latest ticket for its key may install
// what it read, so a slow older answer cannot overwrite a newer one.
export class LatestRefresh {
  private readonly latest = new Map<string, number>();

  /** Starts a refresh for `key`; the returned check is true while it is the latest. */
  begin(key: string): () => boolean {
    const ticket = (this.latest.get(key) ?? 0) + 1;
    this.latest.set(key, ticket);
    return () => this.latest.get(key) === ticket;
  }
}
