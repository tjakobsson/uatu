import { describe, expect, test } from "bun:test";

import type { EmbeddedImageMembership, EmbeddedImagesLookup } from "../preview/embedded-images";
import { createDeferredImageFollow } from "./image-follow";

const README = "/tmp/docs/README.md";
const HERO = "/tmp/docs/hero.svg";
const LOGO = "/tmp/docs/logo.png";

// A page in miniature: what is selected, at which revision, the selection,
// activation, and Follow-switch counters, Follow itself, and the shown
// document's embedded images. Lookups are answered by hand.
function harness() {
  const state = {
    selectedId: README as string | null,
    revision: "e1:1",
    generation: 1,
    activation: 1,
    followSwitches: 1,
    followEnabled: true,
    commitPreview: false,
    membership: { known: false } as EmbeddedImageMembership,
    lookups: 0,
  };
  const followed: string[] = [];
  // One lookup per document revision, shared while in flight, like the learner.
  const lookups = new Map<string, {
    promise: Promise<EmbeddedImagesLookup>;
    answer: (outcome: EmbeddedImagesLookup) => void;
    reject: (error: Error) => void;
  }>();
  const deferral = createDeferredImageFollow({
    guard: documentId => [state.generation, state.activation, state.followSwitches,
      state.selectedId === documentId, state.revision].join("\n"),
    canFollow: () => state.followEnabled && !state.commitPreview,
    lookup: () => {
      const existing = lookups.get(state.revision);
      if (existing) return existing.promise;
      state.lookups++;
      let answer!: (outcome: EmbeddedImagesLookup) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<EmbeddedImagesLookup>((resolve, fail) => { answer = resolve; reject = fail; });
      lookups.set(state.revision, { promise, answer, reject });
      return promise;
    },
    membership: () => state.membership,
    follow: imageId => {
      followed.push(imageId);
      state.selectedId = imageId;
      state.generation++;
    },
  });
  // Answers the lookup for `revision` (the first one by default).
  async function settle(outcome: EmbeddedImagesLookup, membership?: EmbeddedImageMembership, revision = "e1:1"): Promise<void> {
    if (membership) state.membership = membership;
    const lookup = lookups.get(revision)!;
    lookups.delete(revision);
    lookup.answer(outcome);
    await lookup.promise;
    // Let the deferral's continuation run.
    await Promise.resolve();
  }
  async function failByRejection(): Promise<void> {
    const lookup = lookups.get("e1:1")!;
    lookups.delete("e1:1");
    lookup.reject(new Error("request unanswered"));
    await lookup.promise.catch(() => undefined);
    await Promise.resolve();
  }
  return { state, followed, deferral, settle, failByRejection };
}

describe("createDeferredImageFollow — Rule C while membership is unknown", () => {
  test("holds the decision and starts the lookup, moving nothing yet", () => {
    const h = harness();
    h.deferral.defer(README, HERO);
    expect(h.deferral.pending()).toBe(HERO);
    expect(h.state.lookups).toBe(1);
    expect(h.followed).toEqual([]);
  });

  test("an image the document turns out to embed stays", async () => {
    const h = harness();
    h.deferral.defer(README, HERO);
    await h.settle("known", { known: true, ids: new Set([HERO]) });
    expect(h.followed).toEqual([]);
    expect(h.deferral.pending()).toBeNull();
  });

  test("an image the document turns out not to embed is followed", async () => {
    const h = harness();
    h.deferral.defer(README, HERO);
    await h.settle("known", { known: true, ids: new Set() });
    expect(h.followed).toEqual([HERO]);
  });

  test("a failed lookup follows the image, whether it answered nothing or rejected", async () => {
    const answered = harness();
    answered.deferral.defer(README, HERO);
    await answered.settle("failed");
    expect(answered.followed).toEqual([HERO]);

    const rejected = harness();
    rejected.deferral.defer(README, HERO);
    await rejected.failByRejection();
    expect(rejected.followed).toEqual([HERO]);
  });

  test("the latest changed image wins, and a burst waits on one lookup", async () => {
    const h = harness();
    h.deferral.defer(README, HERO);
    h.deferral.defer(README, LOGO);
    expect(h.state.lookups).toBe(1);
    await h.settle("known", { known: true, ids: new Set([HERO]) });
    expect(h.followed).toEqual([LOGO]);
  });

  test("a newer selection decision (a document change) cancels the held decision", async () => {
    const h = harness();
    h.deferral.defer(README, HERO);
    h.deferral.cancel();
    await h.settle("failed");
    expect(h.followed).toEqual([]);
  });

  test("a selection change or a user activation drops it", async () => {
    const moved = harness();
    moved.deferral.defer(README, HERO);
    moved.state.selectedId = "/tmp/docs/other.md";
    moved.state.generation++;
    await moved.settle("failed");
    expect(moved.followed).toEqual([]);

    const activated = harness();
    activated.deferral.defer(README, HERO);
    activated.state.activation++;
    await activated.settle("known", { known: true, ids: new Set() });
    expect(activated.followed).toEqual([]);
  });

  test("an edit to the shown document drops it", async () => {
    const h = harness();
    h.deferral.defer(README, HERO);
    h.state.revision = "e1:2";
    await h.settle("stale");
    expect(h.followed).toEqual([]);
  });

  test("Follow turned off, or switched off and on again, drops it", async () => {
    const off = harness();
    off.deferral.defer(README, HERO);
    off.state.followEnabled = false;
    off.state.followSwitches++;
    await off.settle("failed");
    expect(off.followed).toEqual([]);

    const toggled = harness();
    toggled.deferral.defer(README, HERO);
    toggled.state.followSwitches += 2;
    await toggled.settle("failed");
    expect(toggled.followed).toEqual([]);
  });

  test("a commit preview opened meanwhile drops it", async () => {
    const h = harness();
    h.deferral.defer(README, HERO);
    h.state.commitPreview = true;
    await h.settle("failed");
    expect(h.followed).toEqual([]);
  });

  test("a lookup started for an older decision does not settle a newer one", async () => {
    const h = harness();
    h.deferral.defer(README, HERO);
    // The document was edited; a new image change is held for the new revision.
    h.state.revision = "e1:2";
    h.deferral.defer(README, LOGO);
    // The old revision's lookup answers stale: the newer decision is untouched.
    await h.settle("stale");
    expect(h.deferral.pending()).toBe(LOGO);
    expect(h.followed).toEqual([]);
    // The new revision's lookup settles it.
    await h.settle("known", { known: true, ids: new Set() }, "e1:2");
    expect(h.followed).toEqual([LOGO]);
  });
});
