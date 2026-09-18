// Side-effect-free text/grammar shared by Hub rendering and credential operations.
export const LOCAL_CREDENTIAL_ASSIGNMENT_WARNING =
  "Local workspace credential assignments configure normal tools only. All workspaces run as the Hub OS user, so same-UID processes can inspect runtime files, reach shared agents, unset the configuration, and use credentials assigned elsewhere.";

export const SCP_REMOTE_PATTERN = /^(?:[^@/:\s]+@)?(\[[^\]]+\]|[^/:\s]+):(.+)$/;
