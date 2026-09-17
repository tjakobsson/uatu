// Matches the browser bundle without importing shared/version's source-run
// Git probes. The mock host must never evaluate that module on the server.
export const DEMO_BUILD = { version: "0.0.0", branch: "simulation", commitSha: "mock", commitShort: "mock", buildTime: "", release: false };
