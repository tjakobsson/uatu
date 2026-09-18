// Serialization for worktree operations. Two fences, because they protect
// different things:
//
//   * per-repository queue — keyed by canonical common-directory identity.
//     Two operations on ONE repository never run concurrently, so ref
//     creation, `worktree add`, inventory verification and removal each see
//     a settled repository. Different repositories stay parallel: a slow
//     fetch in one must not stall another workspace's creation.
//   * path reservations — the Hub-wide hierarchy fence every other folder
//     mutation already uses (PathReservationCoordinator). It is what stops a
//     folder rename, an onboarding registration and a worktree creation from
//     racing for overlapping paths; the per-repository queue cannot see them
//     because they belong to other subsystems.
//
// Both are released on every exit path, including a throw, and neither is
// re-entrant: an operation that needs another operation's work asks for it
// before entering, not from inside.

import { PathReservationCoordinator } from "./path-reservations";
import { WorktreeOperationError } from "../shared/worktree-contract";

export type WorktreeOperationScope = {
  // Canonical common-directory identity (worktree-git's repositoryId).
  readonly repositoryId: string;
  // Absolute paths this operation may touch: the source checkout, the
  // destination, the repository root. Overlapping hierarchies conflict.
  readonly paths?: readonly string[];
};

export class WorktreeOperationCoordinator {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pending = new Map<string, number>();

  constructor(private readonly reservations: PathReservationCoordinator = new PathReservationCoordinator()) {}

  // Runs `operation` with the repository queue held and the paths reserved.
  // A path another subsystem already holds is an immediate, actionable
  // conflict rather than a wait: the caller (and the user) learns that
  // something else owns that hierarchy right now.
  run<T>(scope: WorktreeOperationScope, operation: () => Promise<T>): Promise<T> {
    const { repositoryId } = scope;
    const previous = this.queues.get(repositoryId) ?? Promise.resolve();
    this.pending.set(repositoryId, (this.pending.get(repositoryId) ?? 0) + 1);
    const result = previous.then(async () => {
      const reservation = scope.paths?.length ? this.reservations.acquire(scope.paths) : undefined;
      if (scope.paths?.length && !reservation) {
        throw WorktreeOperationError.of(
          "conflict",
          "Another operation is using this folder. Wait for it to finish, then retry.",
          { retry: "refresh" },
        );
      }
      try {
        return await operation();
      } finally {
        reservation?.release();
      }
    }).finally(() => {
      const remaining = (this.pending.get(repositoryId) ?? 1) - 1;
      // The last operation to leave clears the repository's entries, so a
      // long-lived Hub retains nothing per repository it has ever touched.
      if (remaining > 0) this.pending.set(repositoryId, remaining);
      else {
        this.pending.delete(repositoryId);
        this.queues.delete(repositoryId);
      }
    });
    // Successors chain on SETTLEMENT, not on success: one failed operation
    // must not wedge a repository forever.
    this.queues.set(repositoryId, result.then(() => undefined, () => undefined));
    return result;
  }

  // True while any operation holds or awaits this repository's queue — the
  // "no pending operation" condition the create dialog already applies.
  busy(repositoryId: string): boolean {
    return (this.pending.get(repositoryId) ?? 0) > 0;
  }
}
