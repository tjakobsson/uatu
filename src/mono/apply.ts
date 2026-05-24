// Applies a `.uatu.json mono.fontFamily` override (or its absence) by
// writing the value to `--mono-font-family` on `<html>`. Called once
// from shell/boot.ts after the initial /api/state payload arrives.
// When the override is absent, the CSS default already in styles.css
// (`"Hack Nerd Font Mono", ui-monospace, ...`) stands.

import type { MonoConfigPayload } from "../shared/types";

const PROPERTY = "--mono-font-family";

export function applyMonoConfig(config: MonoConfigPayload | undefined): void {
  const root = document.documentElement;
  if (config && typeof config.fontFamily === "string" && config.fontFamily) {
    root.style.setProperty(PROPERTY, config.fontFamily);
  } else {
    // Clear any prior inline override so the CSS default reasserts. Idempotent
    // when no inline value was ever set.
    root.style.removeProperty(PROPERTY);
  }
}
