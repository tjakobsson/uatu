# Release applicability evidence

## Correction to the original record

The proposal and initial PR body claimed that #354, #382, and #410 all reproduce
in stable `v0.7.0`. No recorded tagged-build test supports that claim. It is
withdrawn rather than inferred from issue dates or current-branch tests.

| Issue | Evidence inspected | Stable runtime reproduction |
| --- | --- | --- |
| #354 — mobile composer/answer obstruction and caret scrolling | `git show v0.7.0:src/chat/viewport.ts` contains the occluded-strip keyboard predicate and direct pinned scroll writes on viewport events. These are relevant older mechanisms, not proof of every reported symptom. | Not performed or recorded here. |
| #382 — custom answer obscured by keyboard | The stable viewport controller exists, but `git ls-tree -r --name-only v0.7.0 src/chat` confirms there is no `coordinated-scroll.ts`. Its later hold/anchor behavior cannot be attributed to this tag. | Not performed or recorded here. |
| #410 — stale geometry after returning from the background | The tagged viewport controller listens to viewport/window resize and viewport scroll, but not visibilitychange, pageshow, or focus. This demonstrates a source-level recovery gap, not the actual iOS event sequence. | Not performed or recorded here. |

Commands used for source comparison:

```sh
git show v0.7.0:src/chat/viewport.ts
git show v0.7.0:src/chat/anchor.ts
git ls-tree -r --name-only v0.7.0 src/chat
git log --oneline v0.7.0..main -- src/chat/viewport.ts src/chat/question-form.ts
git log --oneline v0.7.0..HEAD -- src/chat/coordinated-scroll.ts
```

`coordinated-scroll.ts` was introduced after the stable tag by the shell
scrollback change (`b206104`). Regressions in this PR's new answering hold, focus
cleanup and CSS inset precedence are also branch regressions, not independently
established stable-release defects. Maintainer browser probes and our regression
tests exercise current branch code; neither counts as a tagged iPhone build test.

The earlier iPhone 13 Safari evidence in task 6.3 was against a development
working tree without a recorded OS version/build badge. It does not establish
stable impact or installed-PWA acceptance.

## Before squash merge

Keep the truthful `fix(chat)` title. Task 6.5 remains open: record which issue
symptoms reproduce on the latest stable tag, the device/OS and exact build, steps
and result. Visible fix notes should describe only confirmed stable-user impact.
If the correction affects only unreleased functionality, add the documented
Release Please `chore(chat)` override to the PR body before merging. Do not use
the issue filing date as proof in either direction.

## Maintainer decision at merge (2026-09-21)

PR #415 was squash-merged as `7287ac0` with a visible `fix(chat)` note and no
Release Please override. Basis: #354 was filed before the `v0.7.0` tag and
`src/chat/viewport.ts` had not changed between 2026-09-05 and the tag, so its
symptoms are attributed to the stable release; #382 and #410 rest partly on
post-tag code and are carried by the same entry. No tagged-build device
reproduction was recorded; tasks 6.3 and 6.5 are closed on this decision.
