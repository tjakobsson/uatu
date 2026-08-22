import { createHubSignalShutdown, shutdownHub } from "../../src/hub/main";
import { acquireHubStateLease, ensureCanonicalStateDir } from "../../src/hub/state-dir";

const stateRoot = Bun.argv.at(-1);
if (!stateRoot) throw new Error("state root is required");

const canonicalStateRoot = await ensureCanonicalStateDir(stateRoot);
const stateLease = await acquireHubStateLease(canonicalStateRoot);
const handleSignal = createHubSignalShutdown({
  shutdown: () => shutdownHub({
    stopServer() {},
    stateLease,
    cloneJobs: { async close() { throw new Error("fixture clone survived"); } },
    sessions: { async stopAll() {} },
  }),
  reportRetained: () => process.stdout.write("retained\n"),
});
process.on("SIGTERM", handleSignal);
process.stdout.write("locked\n");
