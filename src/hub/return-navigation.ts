export type ReturnWorkspace = {
  id: string;
  displayName: string;
  path: string;
  running: boolean;
  credentialAssignments?: { authentication: string[]; signing: string[] };
};

/** Self-contained so Hub HTML and the workspace bundle execute the same client. */
export function createReturnNavigation(options: {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">;
  changed: (workspace: ReturnWorkspace | null, workspaces: ReturnWorkspace[]) => void;
  timeout?: number;
}) {
  const key = "uatu.hub.return.v1";
  let epoch = 0;
  let controller: AbortController | undefined;
  let verified: ReturnWorkspace | null = null;
  let verifiedAt = 0;
  let session: string | null = null;
  const withhold = () => {
    verified = null;
    verifiedAt = 0;
    options.changed(null, []);
  };
  // Cancel any in-flight validation without discarding what is already
  // verified. A periodic refresh must not blank the control it is refreshing.
  const cancelInFlight = () => {
    epoch++;
    controller?.abort();
  };
  const suspend = () => {
    cancelInFlight();
    withhold();
  };
  const invalidate = () => {
    suspend();
    session = null;
    try { options.storage().removeItem(key); } catch {}
  };
  const validate = async (visitId?: string, sharedState?: Promise<unknown>): Promise<ReturnWorkspace | null> => {
    // Supersede the previous attempt but keep the last verified result on
    // screen: this runs on a 5s timer, and withholding here made the Return
    // control disappear and the bottom navigation reflow on every tick.
    // A negative outcome below still withholds.
    cancelInFlight();
    const generation = epoch;
    const owned = new AbortController();
    controller = owned;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let saved: { version: number; workspaceId: string; sessionHandle: string } | null = null;
    let raw: string | null = null;
    try { raw = options.storage().getItem(key); } catch {}
    try {
      if (raw) {
        const value = JSON.parse(raw);
        if (value?.version !== 1 || typeof value.workspaceId !== "string" || !value.workspaceId
          || typeof value.sessionHandle !== "string" || !value.sessionHandle) {
          invalidate();
          return null;
        }
        saved = value;
      }
    } catch {
      invalidate();
      return null;
    }
    if (!visitId && !saved) return null;
    const read = async (url: string) => {
      const response = await options.fetch(url, { signal: owned.signal, cache: "no-store" });
      if (response.status === 401) invalidate();
      if (!response.ok) throw new Error("Return validation unavailable");
      return response.json();
    };
    try {
      // The deadline includes body reads. Never abort a shared Hub refresh.
      const [state, devices] = await Promise.race([
        Promise.all([sharedState ?? read("/api/hub/state"), read("/api/hub/sessions")]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { owned.abort(); reject(new Error("Return validation timed out")); }, options.timeout ?? 3000);
        }),
      ]);
      if (generation !== epoch || owned.signal.aborted) return null;
      if (!Array.isArray(devices?.sessions) || !Array.isArray(state?.workspaces)) {
        invalidate();
        return null;
      }
      const current = devices.sessions.filter((item: { current?: unknown }) => item?.current === true);
      if (current.length !== 1 || typeof current[0].handle !== "string" || !current[0].handle) {
        invalidate();
        return null;
      }
      const handle = current[0].handle as string;
      if ((session && session !== handle) || (saved && saved.sessionHandle !== handle)) {
        invalidate();
        return null;
      }
      const workspaces: ReturnWorkspace[] = state.workspaces.filter((item: ReturnWorkspace) => item
        && typeof item.id === "string" && typeof item.displayName === "string"
        && typeof item.path === "string" && typeof item.running === "boolean");
      const workspace = workspaces.find(item => item.id === (visitId ?? saved?.workspaceId));
      if (!workspace) {
        invalidate();
        return null;
      }
      if (visitId && !workspace.running) return null;
      session = handle;
      verified = workspace;
      verifiedAt = performance.now();
      try { options.storage().setItem(key, JSON.stringify({ version: 1, workspaceId: workspace.id, sessionHandle: handle })); } catch {}
      options.changed(workspace, workspaces);
      return workspace;
    } catch {
      if (generation === epoch) withhold();
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    validate, invalidate, suspend,
    current: () => verifiedAt && performance.now() - verifiedAt < 5000 ? verified : null,
  };
}
