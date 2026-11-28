import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ListPrices, catalogLoader, priceTable, ratesFor, stepCost, type CatalogLoad } from "./list-prices";

// The shape of models.opencode.ai's v2 catalog, trimmed to what pricing reads.
// gpt-6.1-sol's figures are the public list prices on the day this was written.
const CATALOG = {
  openai: {
    id: "openai", name: "OpenAI", env: [],
    models: {
      "gpt-6.1-sol": {
        id: "gpt-6.1-sol", type: "chat",
        cost: {
          text: {
            input: { price: 2, cache: { read: 0.1, write: { "30m": 2.5, "12h": 5 } }, overrides: [{ when: { context: { gt: 272_000 } }, price: 4, cache: { read: 0.2, write: { "30m": 5, "12h": 10 } } }] },
            output: { price: 10, overrides: [{ when: { context: { gt: 272_000 } }, price: 15 }] },
          },
          multipliers: [{ when: { service_tier: { equals: "priority" } }, factor: { text: 2 } }],
        },
      },
      "per-image": { id: "per-image", type: "image", cost: { text: { input: { unit: "image", price: 1 }, output: { price: 1 } } } },
      "explicit-cache": { id: "explicit-cache", type: "chat", cost: { text: { input: { price: 1, cache: { explicit: { write: 3 } } }, output: { price: 2 } } } },
    },
  },
  reseller: {
    id: "reseller", name: "Reseller", env: [],
    models: { "gpt-6.1-sol": { id: "gpt-6.1-sol", type: "chat", cost: { text: { input: { price: 9 }, output: { price: 9 } } } } },
  },
};

const SOL = { providerId: "openai", modelId: "gpt-6.1-sol" };
const usage = { input: 1_000_000, output: 100_000, reasoning: 50_000, cacheRead: 200_000, cacheWrite: 0, costUsd: 0 };

describe("priceTable and stepCost replicate OpenCode's catalog pricing", () => {
  const table = priceTable(CATALOG);

  test("a step below the context tier is priced at the base rates, reasoning at the output rate", () => {
    const small = { input: 10_000, output: 1_000, reasoning: 500, cacheRead: 2_000, cacheWrite: 1_000 };
    // 10k×$2 + 1.5k×$10 + 2k×$0.1 + 1k×$2.5 (the first cache-write TTL), per million.
    expect(stepCost(ratesFor(table, "openai", "gpt-6.1-sol")!, small)).toBeCloseTo((10_000 * 2 + 1_500 * 10 + 2_000 * 0.1 + 1_000 * 2.5) / 1e6, 12);
  });

  test("context — input plus cache read and write — above the tier size takes the tier's rates", () => {
    expect(stepCost(ratesFor(table, "openai", "gpt-6.1-sol")!, usage)).toBeCloseTo((1_000_000 * 4 + 150_000 * 15 + 200_000 * 0.2) / 1e6, 12);
    // Exactly at the size is not above it.
    expect(stepCost(ratesFor(table, "openai", "gpt-6.1-sol")!, { input: 272_000 })).toBeCloseTo(272_000 * 2 / 1e6, 12);
    expect(stepCost(ratesFor(table, "openai", "gpt-6.1-sol")!, { input: 271_000, cacheWrite: 1_001 })).toBeCloseTo((271_000 * 4 + 1_001 * 5) / 1e6, 12);
  });

  test("only per-token text prices are kept; an explicit cache write price is used when no TTL is listed", () => {
    expect((ratesFor(table, "openai", "per-image") !== undefined)).toBe(false);
    expect(stepCost(ratesFor(table, "openai", "explicit-cache")!, { cacheWrite: 1_000_000 })).toBe(3);
  });

  test("provider and model ids stay separate: a model id with a slash cannot price another provider's model", () => {
    const ambiguous = priceTable({ a: { id: "a", models: { "b/c": { id: "b/c", cost: { text: { input: { price: 1 }, output: { price: 1 } } } } } } });
    expect(ratesFor(ambiguous, "a", "b/c")).toBeDefined();
    expect(ratesFor(ambiguous, "a/b", "c")).toBeUndefined();
  });

  test("entries are keyed by provider and model id; a malformed catalog prices nothing", () => {
    expect(stepCost(ratesFor(table, "reseller", "gpt-6.1-sol")!, { input: 1_000_000 })).toBe(9);
    for (const value of [undefined, null, [], "catalog", { openai: { id: "openai", models: { x: { id: "x", cost: { text: { input: { price: "2" }, output: { price: 1 } } } } } } }]) {
      expect(priceTable(value).size).toBe(0);
    }
  });
});

describe("ListPrices", () => {
  const loaded = (table = priceTable(CATALOG)): CatalogLoad => async () => ({ table, etag: '"v1"' });

  test("replaces OpenCode's zero with the list price of the exact provider and model, once the catalog has loaded", async () => {
    const prices = new ListPrices(loaded());
    // The first zero starts the load; nothing waits for it.
    expect(prices.price(usage, SOL)).toBe(usage);
    await prices.settled();
    expect(prices.price(usage, SOL).costUsd).toBeCloseTo((1_000_000 * 4 + 150_000 * 15 + 200_000 * 0.2) / 1e6, 12);
  });

  test("never overrides a reported price, and leaves usage without tokens, model or catalog match unpriced", async () => {
    const prices = new ListPrices(loaded());
    prices.warm();
    await prices.settled();
    const priced = { ...usage, costUsd: 0.5 };
    expect(prices.price(priced, SOL)).toBe(priced);
    const missing = { input: 10 };
    expect(prices.price(missing, SOL)).toBe(missing);
    const empty = { input: 0, output: 0, costUsd: 0 };
    expect(prices.price(empty, SOL)).toBe(empty);
    expect(prices.price(usage, undefined)).toBe(usage);
    // No fallback to another provider's price for the same model id.
    expect(prices.price(usage, { providerId: "chatgpt", modelId: "gpt-6.1-sol" })).toBe(usage);
    expect(prices.price(usage, { providerId: "openai", modelId: "gpt-6.1-sol-fast" })).toBe(usage);
  });

  test("a zero list price stays unpriced", async () => {
    const prices = new ListPrices(loaded(priceTable({ free: { id: "free", models: { m: { id: "m", cost: { text: { input: { price: 0 }, output: { price: 0 } } } } } } })));
    prices.warm();
    await prices.settled();
    expect(prices.price(usage, { providerId: "free", modelId: "m" })).toBe(usage);
  });

  test("a failed load prices nothing and is retried only after the TTL, revalidating with the stored ETag", async () => {
    let clock = 0;
    const calls: (string | undefined)[] = [];
    const results: (Awaited<ReturnType<CatalogLoad>> | Error)[] = [new Error("offline"), { table: priceTable(CATALOG), etag: '"v1"' }, "unchanged"];
    const prices = new ListPrices(async etag => {
      calls.push(etag);
      const next = results.shift()!;
      if (next instanceof Error) throw next;
      return next;
    }, { ttlMs: 1_000, now: () => clock });
    prices.price(usage, SOL);
    await prices.settled();
    expect(prices.price(usage, SOL)).toBe(usage);
    clock = 999;
    prices.warm();
    expect(calls).toEqual([undefined]);
    clock = 1_000;
    prices.warm();
    await prices.settled();
    expect(hasCost(prices.price(usage, SOL))).toBe(true);
    clock = 2_000;
    prices.warm();
    await prices.settled();
    expect(calls).toEqual([undefined, undefined, '"v1"']);
    // An unchanged catalog keeps the table it has.
    expect(hasCost(prices.price(usage, SOL))).toBe(true);
  });

  test("a catalog not validated for 24 hours is no longer used; a 304 validates it again", async () => {
    let clock = 0;
    const results: (Awaited<ReturnType<CatalogLoad>> | Error)[] = [{ table: priceTable(CATALOG), etag: '"v1"' }, new Error("offline"), "unchanged"];
    const prices = new ListPrices(async () => {
      const next = results.shift()!;
      if (next instanceof Error) throw next;
      return next;
    }, { ttlMs: 1_000, maxAgeMs: 10_000, now: () => clock });
    prices.warm();
    await prices.settled();
    clock = 5_000;
    prices.warm();
    await prices.settled();
    // A failed refresh keeps a still-valid catalog in use.
    expect(hasCost(prices.price(usage, SOL))).toBe(true);
    clock = 9_999;
    expect(hasCost(prices.price(usage, SOL))).toBe(true);
    clock = 10_000;
    // Expired: unpriced, and this lookup starts the next validation.
    expect(prices.price(usage, SOL)).toBe(usage);
    await prices.settled();
    expect(hasCost(prices.price(usage, SOL))).toBe(true);
  });

  test("one load runs at a time", async () => {
    let count = 0;
    let release!: () => void;
    const prices = new ListPrices(() => { count += 1; return new Promise(resolve => { release = () => resolve({ table: priceTable(CATALOG) }); }); });
    prices.warm(); prices.warm(); prices.price(usage, SOL);
    expect(count).toBe(1);
    release();
    await prices.settled();
    expect(count).toBe(1);
  });

  test("without a loader nothing is fetched or priced", () => {
    const prices = new ListPrices(undefined);
    prices.warm();
    expect(prices.price(usage, SOL)).toBe(usage);
  });
});

describe("catalogLoader follows OpenCode's own catalog settings", () => {
  const response = (status: number, body?: unknown, etag?: string) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: etag ? { etag } : {} });

  test("fetches OpenCode's v2 catalog once per call, sending the stored ETag", async () => {
    const requests: { url: string; etag: string | null }[] = [];
    const load = catalogLoader({}, async (input, init) => {
      requests.push({ url: String(input), etag: new Headers(init?.headers).get("if-none-match") });
      return requests.length === 1 ? response(200, CATALOG, '"v1"') : response(304);
    })!;
    const first = await load(undefined);
    expect(first !== "unchanged" && first.etag).toBe('"v1"');
    expect(first !== "unchanged" && ratesFor(first.table, "openai", "gpt-6.1-sol") !== undefined).toBe(true);
    expect(await load('"v1"')).toBe("unchanged");
    expect(requests).toEqual([
      { url: "https://models.opencode.ai/experimental/v2.0/api.json?type=chat", etag: null },
      { url: "https://models.opencode.ai/experimental/v2.0/api.json?type=chat", etag: '"v1"' },
    ]);
  });

  test("uses OPENCODE_MODELS_URL, and a failed response is an error", async () => {
    const urls: string[] = [];
    const load = catalogLoader({ OPENCODE_MODELS_URL: "https://mirror.example" }, async input => { urls.push(String(input)); return response(503); })!;
    await expect(load(undefined)).rejects.toThrow();
    expect(urls).toEqual(["https://mirror.example/experimental/v2.0/api.json?type=chat"]);
  });

  test("OPENCODE_DISABLE_MODELS_FETCH disables it, and OPENCODE_MODELS_PATH reads a file instead of the network", async () => {
    const refuse = async (): Promise<Response> => { throw new Error("no network in this test"); };
    for (const value of ["1", "true", "TRUE"]) expect(catalogLoader({ OPENCODE_DISABLE_MODELS_FETCH: value }, refuse)).toBeUndefined();
    expect(catalogLoader({ OPENCODE_DISABLE_MODELS_FETCH: "0" }, refuse)).toBeDefined();
    const directory = mkdtempSync(path.join(tmpdir(), "uatu-list-prices-"));
    try {
      const file = path.join(directory, "models.json");
      writeFileSync(file, JSON.stringify(CATALOG));
      const loaded = await catalogLoader({ OPENCODE_MODELS_PATH: file, OPENCODE_DISABLE_MODELS_FETCH: "1" }, refuse)!(undefined);
      expect(loaded !== "unchanged" && ratesFor(loaded.table, "openai", "gpt-6.1-sol") !== undefined).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

function hasCost(value: { costUsd?: number }): boolean {
  return (value.costUsd ?? 0) > 0;
}
