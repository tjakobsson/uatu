// Where a Hub user last was in a workspace, so the Hub's dashboard and
// Settings can offer "← Back to <label>". A workspace session page writes it
// (shell/hub-return.ts); the Hub's pages read it (hub/hub-return.ts). Both
// are served from the Hub's one origin (sessions under /s/<slug>/), so they
// share this device's localStorage. The key is scoped to the Hub user, whose
// scope the Hub hands each page; the record holds paths and labels only.

// The <meta> the Hub's proxy adds to a session page, naming the user scope.
export const HUB_USER_SCOPE_META = "uatu-hub-user";

export function hubReturnStorageKey(userScope: string): string {
  return `uatu.hub.return-v1:${userScope}`;
}

export type HubReturnLocation = {
  // The workspace's slug: its session lives at /s/<slug>/.
  workspace: string;
  name: string;
  // The workspace name plus what was open ("uatu · docs/hub.md").
  label: string;
  // Origin-relative: the session path with its query and fragment.
  href: string;
};
