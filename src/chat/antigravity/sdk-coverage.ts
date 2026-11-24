import type { CoverageAnnotations } from "../coverage-annotations";

/**
 * Antigravity coverage annotations (see coverage-annotations.ts). The
 * vocabulary is the Agent Client Protocol's, from `@agentclientprotocol/sdk`:
 * session updates by their `sessionUpdate` kind, methods prefixed `agent:`
 * (sent to agy) or `client:` (answered for agy), and tool kinds prefixed
 * `kind:`. ACP does not enumerate agy's tool names, so the report lists tool
 * kinds and says so.
 *
 * A method counts as used when the provider or connection names it; an
 * unused one needs a reason here, or it reports as unhandled. agy's legacy
 * `session/set_model`, which the provider uses when agy offers only legacy
 * model ids, is outside the methods the SDK declares.
 */
export const antigravityCoverageAnnotations: CoverageAnnotations = {
  reasons: {
    "agent:authenticate": "agy owns its login; UatuCode never signs in for it (design D3).",
    "agent:logout": "agy owns its login; UatuCode never signs out for it (design D3).",
    "agent:session/delete": "Chat offers no conversation deletion.",
    "agent:session/resume": "A conversation is reopened with session/load, whose replay gives its history (design D10).",
    "agent:session/close": "Each conversation has its own process, which is ended instead (design D2).",
    "client:fs/*": "UatuCode advertises no file-system capability, so agy never asks it to read or write files (design D1).",
    "client:terminal/*": "UatuCode advertises no terminal capability, so agy runs its commands itself (design D1).",
    "client:elicitation/*": "UatuCode advertises no elicitation capability; agy asks only through permission requests.",
  },
  behaviorMissing: {},
};
