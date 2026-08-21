import { acquireHubStateLease, ensureCanonicalStateDir } from "../../src/hub/state-dir";

const pressureRequested = Bun.argv.at(-1) === "pressure";
const stateRoot = Bun.argv.at(pressureRequested ? -2 : -1);
if (!stateRoot) throw new Error("state root is required");

const canonicalStateRoot = await ensureCanonicalStateDir(stateRoot);
const lease = await acquireHubStateLease(canonicalStateRoot);
process.stdout.write("locked\n");

const pressure = pressureRequested
  ? setInterval(() => {
      Array.from({ length: 2_000 }, (_, index) => ({ index, value: `lease-${index}` }));
      Bun.gc(true);
    }, 10)
  : undefined;

for await (const chunk of Bun.stdin.stream()) {
  if (new TextDecoder().decode(chunk).includes("release")) break;
}
if (pressure) clearInterval(pressure);
await lease.release();
process.stdout.write("released\n");
