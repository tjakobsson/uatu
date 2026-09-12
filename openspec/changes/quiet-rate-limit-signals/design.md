## Context

See proposal.md — Why. The mechanics that produce the noise:

- `normalization.ts` mints `notice:rate-limit:<envelope.uuid>` on every `rate_limit_event`. Each event is a new id, so each is a new row.
- `composer-status.ts` recovers the standing by scanning the item list from the tail for the newest `rate-limit*` code (`latestRateLimit`), which is why the notices cannot simply stop existing: the composer reads them.
- `#chat-rate-limit` is a `<span role="status">` beside `#chat-plan-usage`, a `<details>` whose readout already lists every window with its percentage and reset.

Two constraints shape the approach. `ConversationItem` is a versioned wire schema in `api/openapi.yaml`, so what may change cheaply is bounded. And the contract's own words for the rate-limit codes already say they "drive the composer's rate-limit badge" — the contract has always described these as composer data; only the client also drew them as rows.

## Goals / Non-Goals

**Goals:**

- One surface for the standing, and it opens.
- The wire keeps its shape: no new item type, no new required field, no changed enum.
- The reset time stays reachable whether or not the login reports a plan.

**Non-Goals:**

- Changing how plan utilization itself is reported, laid out, or pinned to the sidebar.
- Rate limits for any other agent. OpenCode reports none; this is Claude-only.
- Recovering a standing when a conversation is reopened from storage — see Risks.

## Decisions

### The standing stays a `notice`, and the timeline stops drawing it

Alternatives: a new `rate_limit` item type, or a conversation-level field on the projection.

A new item type is the honest model, and there is precedent — revision 12 added `context_report`, revision 13 added `background_task`. Both cost a workspace revision bump with a migration note. A conversation-level field is worse: the projection is built from ordered updates, so it would need a new update kind and a new projection field, and every consumer would grow a second channel for one fact.

The `notice` item already carries everything needed — `code`, `message`, `resetsAt` — and the contract already tells clients these codes are composer data. So the item shape does not change; what changes is that the renderer stops drawing them, exactly as it already skips `context_report`:

```
// A context report is data of the same kind: the readout consumes it,
// the timeline never shows it.
```

The filter is by `code` prefix rather than by `type`, which is weaker than a type test. That is the price of not bumping the schema, and it is contained: one predicate, in one place, with the contract's description updated to match so no client has to guess.

This is still a contract change — a strict client that draws notice rows must stop for these codes — so it carries a workspace revision bump and a CHANGELOG entry with a Migration paragraph, in the shape revision 12 used for `context_report`.

### One item, updated in place; clearing removes it

The id becomes the singleton `notice:rate-limit`, upserted as the standing changes, keyed to nothing about the event that reported it. A conversation held at 77% for an hour then holds one item instead of forty.

That id is the Claude normalizer's, not the wire's: the contract recognizes a standing by its **code**, and tells clients to read the newest notice so coded. So both readers — the timeline's filter and the composer's lookup — go through one code-based predicate. Keying the composer on the id instead would make them disagree, and a producer keeping its standing under another stable id would have it filtered out of the timeline and not found by the composer, showing nowhere at all.

`createdAt` is the onset of the standing, not the latest report, so the data says when the conversation entered it.

The `rate-limit-cleared` notice goes away. A standing that ends is a `remove` update for that id — a state that ended, not an event that happened. The words "requests are allowed again" survive as an announcement (below), which is where they were useful anyway; as a permanent row they were a third kind of noise.

### The plan chip carries the standing; the badge is deleted

One control. Its label resolves in order:

1. A rejection stands → the rate-limit words, which state the block and its reset ("Rate limited · resets 06:00").
2. A plan with windows → the plan words unchanged ("Session 9% · Week 25%"), with the chip's level raised to warning if a warning stands. A warning can name a window the summary does not list ("7-day (overage included)"), which is exactly why the level cannot be derived from the percentages alone.
3. A standing with no plan windows → the rate-limit words.
4. A cost-only report → unchanged.
5. Otherwise hidden.

A rejection displaces the percentages deliberately: once requests are blocked, how full the window is stopped being the actionable fact.

`rateLimitBadgeLabel` survives as the words for cases 1 and 3 rather than being deleted — it already says the right thing, it just had nowhere good to say it.

### The readout gains a standing line

Case 3 leaves a chip that opens a readout with no rows to show. So whenever a standing exists the readout states it — the notice's message and its reset — above the window rows. With a plan, it names which limit is biting among the windows listed; without one, it is the whole readout. Either way the reset is reachable by opening the chip, which is what the spec requires.

### The announcement moves to a dedicated live region

The badge was `role="status"`, so a standing announced itself on arrival. A `<summary>` cannot carry that role, and folding the text into the chip would silently drop the announcement — the accessibility regression hiding inside a visual simplification.

A visually-hidden `role="status"` span beside the composer keeps it, announcing the standing when it begins, changes level, or is retired. The composer's existing status live region is not reused: it is driven by the routine state and re-announcing it on every rate-limit change would talk over the state the user is actually waiting on.

## Risks / Trade-offs

- **A code-prefix filter in the render path is weaker than a type test** → One predicate in one place, named and commented against the `context_report` precedent, with a unit test that a rate-limit notice yields no rendered row and a `refusal-fallback` notice still does.
- **A strict third-party client keeps drawing the rows** → It is not wrong to, and nothing breaks; the revision bump and the Migration paragraph tell it to stop. This is the same accommodation revision 12 made.
- **A reopened conversation has no standing until the next report** → Already true today: rate-limit events are live-only, and the stored transcript admits no such record, so nothing regresses. The plan readout has the same property. Not fixed here.
- **A rejection hides the percentages** → Deliberate, and the figures are one click away in the readout.
- **Removing an item is a newer path than upserting one** → The `remove` update and its wire event already exist and are exercised by the refusal-fallback supersede path; the tasks verify a cleared standing reaches a connected client rather than assuming it.

## Migration Plan

The workspace revision bumps with the rate-limit description change, touching `api/contract.json`, `api/openapi.yaml` (version, summary, `x-uatu-revisions`), `src/shared/version.ts`, and an `api/CHANGELOG.md` section with a Migration paragraph. CI's compatibility step is run locally before the PR, per the project's contract discipline.

No rollback concern: the change is client presentation plus a narrowed emission. A client on the previous revision that still draws the rows sees today's behavior.
