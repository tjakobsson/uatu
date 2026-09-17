// The onboarding binding for verified worktree checkouts (task 4.3).
//
// Section 3 left registration as a seam so the journal could be tested
// without the Hub's two-store commit. This is the real implementation: it
// hands a VERIFIED checkout to WorkspaceOnboardingCoordinator, which commits
// the registry entry — parent relationship included — and its (empty) own
// assignment set as one journaled transaction, then performs an optional
// start as post-commit intent.
//
// What a child does NOT get: credential assignments of its own, a copied
// configuration, or any personal/per-device state. Those are read live from
// the parent through the registry link (registry.WorkspaceWorktreeLink), so
// a parent policy change applies to every child with nothing to re-copy.

import type { WorkspaceOnboardingCoordinator } from "./onboarding";
import type { WorkspaceRegistry } from "./registry";
import type { WorktreeRegistrar } from "./worktree-journal";

export type OnboardingWorktreeRegistrarOptions = {
  onboarding: Pick<WorkspaceOnboardingCoordinator, "configureWorktree">;
  registry: Pick<WorkspaceRegistry, "byId">;
};

export function createOnboardingWorktreeRegistrar(options: OnboardingWorktreeRegistrarOptions): WorktreeRegistrar {
  return {
    async register(input) {
      const result = await options.onboarding.configureWorktree({
        path: input.path,
        // The child's display name IS its exact local branch, slashes
        // included; there is no separate child name to edit.
        displayName: input.displayName,
        link: {
          parentWorkspaceId: input.parentWorkspaceId,
          repositoryId: input.identity.repositoryId,
          checkoutId: input.identity.checkoutId,
        },
        // Stopped by default: a start is requested explicitly and its
        // failure leaves the configured workspace stopped.
        start: input.start,
      });
      return {
        workspaceId: result.entry.id,
        started: result.started,
        ...(result.startError === null ? {} : { startError: result.startError }),
      };
    },
  };
}
