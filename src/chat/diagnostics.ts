import type { ChatAvailability, ChatProbeOutcome } from "./types";

// Renders a failed startup as a block a user can paste into a bug report
// unchanged. The point of the whole change is that this text names its own
// cause: a refused connection at a `/mnt/c/...` executable reads as a Windows
// shim under WSL2 without anyone having to ask a follow-up question.
export function formatDiagnostics(availability: Extract<ChatAvailability, { state: "unavailable" }>): string {
  const lines = [availability.message, ""];
  const diagnostics = availability.diagnostics;
  if (!diagnostics) return availability.message;

  const field = (label: string, value: string) => lines.push(`${label.padEnd(12)}${value}`);
  field("executable", diagnostics.executable ?? "not resolved");
  for (const shadowed of diagnostics.shadowedExecutables) field("shadowed", shadowed);
  field("version", diagnostics.version ?? "could not be determined");
  field("endpoint", diagnostics.endpoint ?? "none");
  field("waited", `${(diagnostics.elapsedMs / 1000).toFixed(1)}s, ${diagnostics.probes} probe${diagnostics.probes === 1 ? "" : "s"}`);
  field("last probe", describeProbe(diagnostics.lastProbe));
  lines.push("", "stdout:", diagnostics.stdout || "(empty)", "", "stderr:", diagnostics.stderr || "(empty)");
  return lines.join("\n");
}

export function describeProbe(outcome: ChatProbeOutcome): string {
  switch (outcome.kind) {
    case "none": return "no probe completed";
    case "refused": return "connection refused";
    case "abandoned": return "connection accepted but never answered";
    case "http-status": return `HTTP ${outcome.status}`;
    case "unhealthy-body": return `HTTP ${outcome.status} with a non-healthy body`;
    case "healthy": return `HTTP ${outcome.status} healthy`;
    case "unknown": return `unrecognized failure: ${outcome.error}`;
  }
}
