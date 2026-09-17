import { describe, expect, test } from "bun:test";

import { PathReservationCoordinator } from "./path-reservations";
import { WorktreeOperationCoordinator } from "./worktree-coordinator";
import { WorktreeOperationError } from "../shared/worktree-contract";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveInner, rejectInner) => {
    resolve = resolveInner;
    reject = rejectInner;
  });
  return { promise, resolve, reject };
}

describe("per-repository serialization", () => {
  test("two operations on one repository never overlap", async () => {
    const coordinator = new WorktreeOperationCoordinator();
    const order: string[] = [];
    const gate = deferred();

    const first = coordinator.run({ repositoryId: "atlas" }, async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = coordinator.run({ repositoryId: "atlas" }, async () => {
      order.push("second:start");
    });

    await Bun.sleep(1);
    expect(order).toEqual(["first:start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("different repositories proceed in parallel", async () => {
    const coordinator = new WorktreeOperationCoordinator();
    const gate = deferred();
    const order: string[] = [];

    const blocked = coordinator.run({ repositoryId: "atlas" }, async () => {
      order.push("atlas");
      await gate.promise;
    });
    await coordinator.run({ repositoryId: "beacon" }, async () => {
      order.push("beacon");
    });

    expect(order).toEqual(["atlas", "beacon"]);
    gate.resolve();
    await blocked;
  });

  test("a failed operation does not wedge its repository", async () => {
    const coordinator = new WorktreeOperationCoordinator();
    await expect(coordinator.run({ repositoryId: "atlas" }, async () => {
      throw new Error("git exploded");
    })).rejects.toThrow("git exploded");
    expect(await coordinator.run({ repositoryId: "atlas" }, async () => "next")).toBe("next");
    expect(coordinator.busy("atlas")).toBe(false);
  });

  test("busy reports a queued operation and clears once the queue drains", async () => {
    const coordinator = new WorktreeOperationCoordinator();
    const gate = deferred();
    expect(coordinator.busy("atlas")).toBe(false);
    const running = coordinator.run({ repositoryId: "atlas" }, () => gate.promise);
    const queued = coordinator.run({ repositoryId: "atlas" }, async () => undefined);
    expect(coordinator.busy("atlas")).toBe(true);
    gate.resolve();
    await Promise.all([running, queued]);
    expect(coordinator.busy("atlas")).toBe(false);
  });
});

describe("path reservations", () => {
  test("a path another subsystem holds is an actionable conflict, not a wait", async () => {
    const reservations = new PathReservationCoordinator();
    const coordinator = new WorktreeOperationCoordinator(reservations);
    const held = reservations.acquire(["/repos/atlas.worktrees"]);
    expect(held).toBeDefined();

    const attempt = coordinator.run(
      { repositoryId: "atlas", paths: ["/repos/atlas.worktrees/feature-login"] },
      async () => "created",
    );
    await expect(attempt).rejects.toBeInstanceOf(WorktreeOperationError);
    await attempt.catch((error: WorktreeOperationError) => {
      expect(error.detail.code).toBe("conflict");
      expect(error.detail.retry).toBe("refresh");
      // Sanitized: a conflict message never publishes the contested path.
      expect(error.detail.message).not.toContain("/repos");
    });

    held?.release();
    expect(await coordinator.run({ repositoryId: "atlas", paths: ["/repos/atlas.worktrees/feature-login"] }, async () => "created")).toBe("created");
  });

  test("reservations are released even when the operation throws", async () => {
    const reservations = new PathReservationCoordinator();
    const coordinator = new WorktreeOperationCoordinator(reservations);
    await expect(coordinator.run({ repositoryId: "atlas", paths: ["/repos/atlas"] }, async () => {
      expect(reservations.isReserved("/repos/atlas/nested")).toBe(true);
      throw new Error("git exploded");
    })).rejects.toThrow("git exploded");
    expect(reservations.isReserved("/repos/atlas")).toBe(false);
  });

  test("an operation holds its whole hierarchy while it runs", async () => {
    const reservations = new PathReservationCoordinator();
    const coordinator = new WorktreeOperationCoordinator(reservations);
    const gate = deferred();
    const running = coordinator.run({ repositoryId: "atlas", paths: ["/repos/atlas.worktrees/feature-login"] }, () => gate.promise);
    await Bun.sleep(1);
    expect(reservations.isReserved("/repos/atlas.worktrees")).toBe(true);
    expect(reservations.isReserved("/repos/beacon")).toBe(false);
    gate.resolve();
    await running;
    expect(reservations.isReserved("/repos/atlas.worktrees")).toBe(false);
  });
});
