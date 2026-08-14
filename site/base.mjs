// Single source for the GitHub Pages base path. astro.config.mjs feeds it to
// Astro (which exposes it as import.meta.env.BASE_URL for components), and
// site.test.ts plus scripts/check-api-site-links.ts read it here instead of
// hardcoding the literal — so changing the base cannot silently break links,
// fonts, or canonicals while the tests keep asserting the old prefix.
export const base = "/uatu";
