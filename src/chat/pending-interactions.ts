import { types } from "node:util";
import type { NormalizedProviderEvent, PendingPermission, PendingQuestion } from "./provider";
import type { PermissionRequest, QuestionRequest } from "./types";

/**
 * The permission and question requests a provider is waiting on the user
 * for, when the agent hands them to the provider as callbacks it must answer
 * (the Claude Agent SDK's `canUseTool`, an ACP client's permission request)
 * rather than holding them on a server of its own.
 *
 * The rules:
 * - each request settles once, by answer, abandonment or cancellation;
 * - a request is registered before its cancellation trigger is observed, so
 *   an already-fired trigger settles it at once, unannounced; a new cancel
 *   is an operation of its own;
 * - registration emits `interaction.requested`; an unanswered end emits
 *   `interaction.abandoned` with the card resolved as rejected; an answer
 *   emits nothing, because the adapter publishes the resolutions it brokered.
 * - operations are serialized: a call into the holder made by agent code
 *   while an operation runs is deferred, and runs, in order, before the
 *   outermost operation returns.
 *
 * What a request's result looks like, and what an answer or rejection turns
 * into, belongs to the agent: the holder carries each request's `detail`
 * without reading it.
 */

export type InteractionKind = "permission" | "question";

/**
 * What ends a request without an answer: an `AbortSignal`, or a subscribe
 * function that calls `cancel` once the agent cancels and returns an
 * unsubscribe. A subscribe function returns `"cancelled"` instead when the
 * agent had cancelled the request before it was registered (ACP's
 * `session/cancel` arriving first): like an aborted signal, that settles the
 * request at once, unannounced, ahead of any call made meanwhile. A `cancel`
 * call, even during subscription, is a new cancellation and waits its turn
 * behind calls made before it.
 */
export type CancellationTrigger = AbortSignal | ((cancel: () => void) => (() => void) | "cancelled");

/** The reason a cancellation trigger passes to the request's `abandoned`. */
export const INTERRUPTED_REASON = "The turn was interrupted before the user answered.";

/** The reason a request replaced by its redelivery passes to its `abandoned`. */
export const SUPERSEDED_REASON = "The agent asked again before the user answered.";

export type PendingInteraction<Detail> = {
  readonly requestId: string;
  readonly conversationId: string;
  readonly kind: InteractionKind;
  // The holder's plain copy of the card, taken at registration.
  readonly item: PermissionRequest | QuestionRequest;
  readonly detail: Detail;
  /**
   * Settles with the user's answer. Emits nothing; a settled request ignores
   * it. A result that is a thenable is refused as `answer` refuses one: the
   * request stays pending and this throws a TypeError.
   */
  settle<Value>(result: Synchronous<Value>): void;
  /** Settles with the request's abandoned result and announces it. */
  abandon(reason: string): void;
};

export type InteractionRegistration<Detail, Result> = {
  conversationId: string;
  // Its `requestId` and `type` (the request's kind), with `conversationId`,
  // identify the request.
  item: PermissionRequest | QuestionRequest;
  detail: Detail;
  cancellation: CancellationTrigger;
  // The agent's result for a request that ends unanswered; synchronous, as
  // an answer's is.
  abandoned: (reason: string) => Synchronous<Result>;
  // The agent's result when the holder refuses the card's data (see
  // `await`); synchronous, as every result is. Without it, the promise
  // rejects with the refusal. A valid card whose subscription throws always
  // rejects.
  whenRefused?: (error: unknown) => Synchronous<Result>;
  // An object of the caller's that names this registration, for
  // `abandonRegistration`: a provider whose requests outlive no single
  // conversation-wide sweep (one session among several for a conversation)
  // ends exactly the ones it made.
  token?: object;
};

export type InteractionEmit = (conversationId: string, event: Omit<NormalizedProviderEvent, "conversationId">) => void;

export type PendingInteractionsOptions = {
  // Where an error goes that no caller can receive: a publication that threw
  // during an `await`, whose caller holds only the request's promise, or the
  // failure of a call that was deferred and so had already returned.
  report?: (error: unknown) => void;
};

export class PendingInteractions<Detail> {
  // Keyed by conversation, kind and request id together: two conversations,
  // or a permission and a question, may use the same request id.
  private readonly pending = new Map<string, Registered<Detail>>();
  // Operations run one at a time. Agent code an operation calls (a mapper,
  // an unsubscribe, a subscribe function, the emit) may call back into the
  // holder; such a call is deferred, and the outermost operation runs the
  // deferred ones in order, synchronously, before it returns.
  private busy = false;
  private readonly deferred: Array<{ operation: () => void; deliver: (error: unknown) => void }> = [];
  // The first error of the operation running now: what it threw, or a
  // publication that threw during it.
  private failure: { error: unknown } | undefined;
  private readonly report: (error: unknown) => void;

  constructor(private readonly emit: InteractionEmit, options: PendingInteractionsOptions = {}) {
    // A reporter that throws never escapes: the error goes to the console.
    this.report = error => {
      try {
        if (options.report) options.report(error);
        else console.error(error);
      } catch (failure) {
        try {
          console.error(error, failure);
        } catch { /* nowhere left to report it */ }
      }
    };
  }

  /**
   * Registers one request and resolves with its result when the user
   * answers, when the trigger fires, or when the request is abandoned, so a
   * waiting agent is never left hanging. Called during another operation,
   * the registration runs once that operation is done, and the promise
   * behaves as if `await` had been called then. It never throws: a
   * publication that throws during it goes to `report`.
   *
   * A request redelivered while its original still waits replaces it: the
   * new request is announced and is the one replies, lists and abandonment
   * reach. The original then settles quietly through its own `abandoned`
   * with `SUPERSEDED_REASON`: it emits nothing, since an abandoned card would
   * reject the id the new request now shows, and its trigger is released.
   *
   * A cancellation subscribe function that throws rejects the promise with
   * its error; the request is removed and was never announced, and a
   * request it would have replaced stays exactly as it was.
   */
  await<Result>(registration: InteractionRegistration<Detail, Result>): Promise<Result> {
    return new Promise<Result>((resolve, reject) => this.run(() => this.register(registration, resolve, reject), this.report));
  }

  /**
   * Answers a pending request as one operation: the request is claimed, the
   * agent's `map` turns the answer into its result, and the request settles
   * with it. A cancel that `map` causes is deferred, so it finds the request
   * settled. The promise is this answer's own outcome, settled once its
   * turn has run: it resolves when the request settled, and rejects with
   * `map`'s error (an answer the request refuses, which leaves the request
   * pending with nothing emitted) or with today's error when no such request
   * is pending.
   *
   * The result's type is not linked to the request's: replies arrive by
   * conversation, request id and kind, with no typed handle on the
   * registration, so the provider keeps a request's answers and its
   * `abandoned` result consistent. The holder checks only, at run time, that
   * the result is synchronous and plain (see `thenableRefusal`); the
   * `Synchronous` type refuses a promise-returning mapping at compile time.
   */
  answer<Mapped>(conversationId: string, requestId: string, kind: InteractionKind, map: (pending: PendingInteraction<Detail>) => Synchronous<Mapped>): Promise<void> {
    const outcome = this.tryAnswer(conversationId, requestId, kind, map);
    if (outcome.status === "settled") return Promise.resolve();
    if (outcome.status === "refused") return Promise.reject(outcome.error);
    return outcome.done;
  }

  /**
   * `answer`, with its outcome reported synchronously when the answer ran at
   * once: `settled` when the request settled with the result, `refused` with
   * the error otherwise (no such request, `map`'s error, or a result the
   * holder refuses), and `deferred` with the promise of an answer made
   * during another operation. For a provider whose reply must report its
   * own outcome in the same turn.
   */
  tryAnswer<Mapped>(conversationId: string, requestId: string, kind: InteractionKind, map: (pending: PendingInteraction<Detail>) => Synchronous<Mapped>): AnswerOutcome {
    // A promise exists only for a deferred answer: one that ran at once
    // reports its outcome directly, and no promise machinery (whose species
    // lookup could run a caller's code) is involved.
    let outcome: AnswerOutcome | undefined;
    let later: { resolve: () => void; reject: (error: unknown) => void } | undefined;
    this.run(() => {
      this.find(conversationId, requestId, kind).answer(map);
      if (later) later.resolve();
      else outcome = { status: "settled" };
    }, error => {
      if (later) later.reject(error);
      else outcome = { status: "refused", error };
    });
    if (outcome) return outcome;
    const done = new Promise<void>((resolve, reject) => { later = { resolve, reject }; });
    return { status: "deferred", done };
  }

  /** The pending request a reply addresses; throws when it is not this conversation's request of this kind. */
  require(conversationId: string, requestId: string, kind: InteractionKind): PendingInteraction<Detail> {
    return this.find(conversationId, requestId, kind).handle();
  }

  /**
   * Ends exactly the registrations made with these tokens, visibly, as
   * `abandon` ends a conversation's, and in the same order: the holder's own
   * (a redelivery keeps its original's place). A registration no longer
   * current (settled, or superseded under the same key) is left alone.
   */
  abandonRegistrations(tokens: Iterable<object>, reason: string): void {
    this.run(() => {
      // Read inside the operation: anything the iterable's own code sets off
      // is deferred behind this sweep.
      const wanted = new Set(tokens);
      for (const key of [...this.pending.keys()]) {
        const current = this.pending.get(key);
        if (current?.token !== undefined && wanted.has(current.token) && !current.settled()) current.end(reason, true);
      }
    });
  }

  /**
   * A conversation that can no longer answer (its session ended, failed or
   * was retired, or the workspace is shutting down): its requests end
   * visibly, in registration order. A request that agent code delivers
   * during the sweep registers after it, as a new request.
   */
  abandon(conversationId: string, reason: string): void {
    this.run(() => {
      for (const key of [...this.pending.keys()]) {
        const current = this.pending.get(key);
        if (current?.conversationId === conversationId) current.end(reason, true);
      }
    });
  }

  /**
   * The pending set of one kind, for the adapter's reconnect recovery: a
   * request whose live announcement a client missed is otherwise unknowable.
   * Every conversation's, each naming its own.
   */
  list(kind: "permission"): PendingPermission[];
  list(kind: "question"): PendingQuestion[];
  list(kind: InteractionKind): PendingPermission[] | PendingQuestion[] {
    // Each card is a fresh copy, so a listed card is the reader's own.
    const items = [...this.pending.values()].filter(pending => pending.kind === kind);
    return kind === "permission"
      ? items.map(pending => pendingPermission(pending.conversationId, pending.card() as PermissionRequest))
      : items.map(pending => pendingQuestion(pending.conversationId, pending.card() as QuestionRequest));
  }

  private find(conversationId: string, requestId: string, kind: InteractionKind): Registered<Detail> {
    const pending = this.pending.get(pendingKey(conversationId, requestId, kind));
    if (!pending) throw new Error(`no pending ${kind} ${requestId} for this conversation`);
    return pending;
  }

  /**
   * Runs an operation now, or after the one running. Each operation's error
   * goes to its own caller: to `deliver` when given; otherwise, for a call
   * that ran at once, it is rethrown once the deferred calls have run too,
   * and for a deferred call, whose caller has already returned, to `report`.
   */
  private run(operation: () => void, deliver?: (error: unknown) => void): void {
    if (this.busy) {
      this.deferred.push({ operation, deliver: deliver ?? this.report });
      return;
    }
    this.busy = true;
    let own: { error: unknown } | undefined;
    try {
      own = this.step(operation);
      if (own && deliver) {
        const error = own.error;
        own = undefined;
        this.deliver(deliver, error);
      }
    } finally {
      // Nothing may leave the holder busy or its queue stuck.
      try {
        for (let next = this.deferred.shift(); next; next = this.deferred.shift()) {
          const failure = this.step(next.operation);
          if (failure) this.deliver(next.deliver, failure.error);
        }
      } finally {
        this.busy = false;
      }
    }
    if (own) throw own.error;
  }

  // Cleanup is best-effort: a trigger whose unsubscribe throws must not keep
  // the request from settling, nor stop an abandonment from reaching the
  // requests after it. Its error is reported, apart from every caller's
  // outcome; a stale listener only finds the request settled.
  private release(unsubscribe: (() => void) | undefined): void {
    try {
      unsubscribe?.();
    } catch (error) {
      this.report(error);
    }
  }

  private deliver(deliver: (error: unknown) => void, error: unknown): void {
    try {
      deliver(error);
    } catch (failure) {
      this.report(failure);
    }
  }

  private step(operation: () => void): { error: unknown } | undefined {
    this.failure = undefined;
    try {
      operation();
    } catch (error) {
      this.failure ??= { error };
    }
    // Assigned during the operation, which the checker cannot see.
    const failure = this.failure as { error: unknown } | undefined;
    this.failure = undefined;
    return failure;
  }

  // A publication that throws never stops settlement: the error is kept as
  // the running operation's.
  private publish(conversationId: string, event: Omit<NormalizedProviderEvent, "conversationId">): void {
    try {
      this.emit(conversationId, event);
    } catch (error) {
      this.failure ??= { error };
    }
  }

  private register<Result>(registration: InteractionRegistration<Detail, Result>, resolve: (result: Result) => void, reject: (error: unknown) => void): void {
    // The only place the agent's promise is settled. Its last step checks a
    // result for a `then` (by descriptor, running no code), right before
    // `resolve`, after every callback that could have changed it: settlement
    // never adopts a thenable, and the promise rejects with a TypeError
    // instead.
    const settleAgent = (outcome: Outcome<Result>) => {
      if ("error" in outcome) {
        reject(outcome.error);
        return;
      }
      const refusal = thenableRefusal(outcome.value, outcome.subject);
      if (refusal) reject(refusal);
      else resolve(outcome.value);
    };
    // Every field of the registration is read once. A field that cannot be
    // read rejects the request; only a refusal of the card's data goes to
    // `whenRefused`. Either way nothing is registered or emitted.
    let fields: RegistrationFields<Detail, Result>;
    try {
      fields = readRegistration(registration);
    } catch (error) {
      settleAgent({ error });
      return;
    }
    const { whenRefused } = fields;
    const refuse = (error: unknown) => {
      if (!whenRefused) {
        settleAgent({ error });
        return;
      }
      try {
        settleAgent({ value: whenRefused(error), subject: "a `whenRefused` mapping" });
      } catch (failure) {
        settleAgent({ error: failure });
      }
    };
    let prepared: Prepared<Detail, Result>;
    try {
      prepared = prepare(fields);
    } catch (error) {
      refuse(error);
      return;
    }
    const { conversationId, requestId, kind, snapshot, detail, cancellation, abandoned } = prepared;
    // The holder's card stays private: every reader gets its own copy.
    const card = () => structuredClone(snapshot);
    const key = pendingKey(conversationId, requestId, kind);
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    // Each subscription is released at most once, however many paths end
    // the request.
    const releaseSubscription = () => {
      const current = unsubscribe;
      unsubscribe = undefined;
      this.release(current);
    };
    // Settlement is claimed before any agent code runs, so the first end
    // wins. A mapper that throws still ends the request, as visibly as its
    // result would have, and the agent's promise rejects with its error.
    // A result that is a thenable (or cannot be inspected) still ends the
    // request; `settleAgent` turns it into a TypeError.
    // How a request ends: an answer (settled before cleanup), an announced
    // abandonment, or a quiet one (a redelivery replaced it).
    type Ending = "answered" | "announced" | "quiet";
    const finish = (outcome: () => Result, ending: Ending, subject: string) => {
      if (settled) return;
      settled = true;
      let result: Outcome<Result>;
      try {
        result = { value: outcome(), subject };
      } catch (error) {
        result = { error };
      }
      complete(result, ending);
    };
    const complete = (result: Outcome<Result>, ending: Ending) => {
      const deliver = () => settleAgent(result);
      if (this.pending.get(key) === record) this.pending.delete(key);
      // An answer settles the agent's promise before any cleanup runs: its
      // result was checked a moment ago and resolution reads it now, so
      // nothing an unsubscribe does to that object afterwards can change the
      // outcome. Every abandonment, quiet or announced, settles after its
      // cleanup, so `settleAgent`'s check sees what cleanup left.
      if (ending === "answered") deliver();
      releaseSubscription();
      if (ending === "announced") {
        const resolved = card();
        this.publish(conversationId, {
          updates: [{ kind: "upsert", item: resolved.type === "question"
            ? { ...resolved, status: "resolved", outcome: { kind: "rejected" } }
            : { ...resolved, status: "resolved", outcome: "rejected" } }],
          outcome: "handled",
          eventType: "interaction.abandoned",
        });
      }
      if (ending !== "answered") deliver();
    };
    const end = (reason: string, announce: boolean) => finish(() => abandoned(reason), announce ? "announced" : "quiet", "an `abandoned` mapping");
    // The claim is released when the agent refuses the answer: the request
    // stays pending and nothing is published.
    const answer = (map: (pending: PendingInteraction<Detail>) => unknown) => {
      if (settled) throw new Error(`no pending ${kind} ${requestId} for this conversation`);
      settled = true;
      let value: unknown;
      try {
        value = map(handle());
      } catch (error) {
        settled = false;
        throw error;
      }
      // Mapping is synchronous: a promise's outcome would arrive after the
      // request settled and the reply reported success. It is refused like
      // any answer the request does not accept, and its outcome ignored.
      const refusal = thenableRefusal(value);
      if (refusal) {
        settled = false;
        throw refusal;
      }
      // The untyped boundary (see `answer`): a reply's result is the
      // provider's to keep consistent with the request's; the holder has
      // checked only that it is a synchronous, plain result.
      complete({ value: value as Result, subject: "an answer's mapping" }, "answered");
    };
    // What callers get: a fresh, frozen handle with a copy of the card. The
    // holder's own paths (triggers, sweeps, supersession) never go through
    // one, so nothing a caller does to it reaches them.
    const settleCall = (result: unknown) => this.run(() => {
      if (settled) return;
      const refusal = thenableRefusal(result);
      if (refusal) throw refusal;
      // The untyped boundary, as for `answer`.
      finish(() => result as Result, "answered", "an answer's mapping");
    });
    const abandonCall = (reason: string) => this.run(() => end(reason, true));
    const handle = (): PendingInteraction<Detail> => Object.freeze({
      requestId,
      conversationId,
      kind,
      item: card(),
      detail,
      settle: settleCall,
      abandon: abandonCall,
    });
    // Registration precedes observing the trigger: a trigger that fired in
    // between would otherwise strand a card while the agent waits on it.
    // Replacing in place keeps the request id's place in the lists. The
    // request it replaces is settled only once this one is announced, so a
    // failed subscription can put it back untouched.
    const previous = this.pending.get(key);
    const record: Registered<Detail> = { conversationId, kind, token: fields.token, card, handle, end, answer, settled: () => settled };
    this.pending.set(key, record);
    // A cancel delivered from here on is a call of its own: during the
    // subscription it waits behind any call made before it.
    // A signal's listener has no caller to rethrow to (EventTarget would
    // surface it as uncaught), so its errors go to `report`; an explicit
    // `cancel()` call keeps the rethrow rule.
    const onCancel = typeof cancellation === "function"
      ? () => abandonCall(INTERRUPTED_REASON)
      : () => this.run(() => end(INTERRUPTED_REASON, true), this.report);
    let subscribed: (() => void) | "cancelled";
    try {
      subscribed = subscribe(cancellation, onCancel);
    } catch (error) {
      // Never announced: the replacement leaves quietly, a later cancel
      // finds it settled, and the request it replaced is back as it was.
      settled = true;
      if (this.pending.get(key) === record) {
        if (previous && !previous.settled()) this.pending.set(key, previous);
        else this.pending.delete(key);
      }
      // A valid card whose subscription failed is not a refusal of its data:
      // the caller learns of the failure itself.
      settleAgent({ error });
      return;
    }
    if (subscribed === "cancelled") {
      // A trigger that had fired before registration settles the request at
      // once, unannounced, ahead of any call made meanwhile; its abandoned
      // card resolves the shared id, so a request it replaced settles
      // quietly too.
      end(INTERRUPTED_REASON, true);
      previous?.end(SUPERSEDED_REASON, false);
      return;
    }
    unsubscribe = subscribed;
    // A request whose announcement the emit fails to publish stays
    // registered and listed for recovery.
    this.publish(conversationId, { updates: [{ kind: "upsert", item: card() }], outcome: "handled", eventType: "interaction.requested" });
    previous?.end(SUPERSEDED_REASON, false);
  }
}

type Registered<Detail> = {
  conversationId: string;
  kind: InteractionKind;
  // The caller's token for `abandonRegistrations`, if it gave one.
  token: object | undefined;
  // A fresh copy of the private card, and a fresh handle for a caller.
  card: () => PermissionRequest | QuestionRequest;
  handle: () => PendingInteraction<Detail>;
  // Ends the request within the current operation; quietly when `announce`
  // is false (a redelivery replaced it).
  end: (reason: string, announce: boolean) => void;
  // Answers the request within the current operation; see `answer`.
  answer: (map: (pending: PendingInteraction<Detail>) => unknown) => void;
  settled: () => boolean;
};

type Prepared<Detail, Result> = {
  conversationId: string;
  requestId: string;
  kind: InteractionKind;
  snapshot: PermissionRequest | QuestionRequest;
  detail: Detail;
  cancellation: CancellationTrigger;
  abandoned: (reason: string) => Result;
};

type Outcome<Result> = { value: Result; subject: string } | { error: unknown };

export type AnswerOutcome =
  | { status: "settled" }
  | { status: "refused"; error: unknown }
  | { status: "deferred"; done: Promise<void> };

type RegistrationFields<Detail, Result> = {
  conversationId: string;
  item: unknown;
  detail: Detail;
  cancellation: CancellationTrigger;
  abandoned: (reason: string) => Result;
  whenRefused: ((error: unknown) => Result) | undefined;
  token: object | undefined;
};

/** Each field of a registration, read once; a conversation id must be a string. */
function readRegistration<Detail, Result>(registration: InteractionRegistration<Detail, Result>): RegistrationFields<Detail, Result> {
  const conversationId = registration.conversationId;
  const item = registration.item;
  const detail = registration.detail;
  const cancellation = registration.cancellation;
  const abandoned = registration.abandoned;
  const whenRefused = registration.whenRefused;
  const token = registration.token;
  if (typeof conversationId !== "string") throw new TypeError("a pending interaction needs a conversation id");
  if (token !== undefined && (token === null || typeof token !== "object")) throw new TypeError("a pending interaction's token must be an object");
  return { conversationId, item, detail, cancellation, abandoned, whenRefused, token };
}

/**
 * Validates a registration's card. The card must be plain data (see
 * `plainCopy`); its identity comes from that copy, read as own data: a
 * permission or question, a request id that is any string (`""` included),
 * and an owner, when the card names one, that is the conversation it is
 * registered under, which the UI addresses replies to.
 */
function prepare<Detail, Result>(registration: RegistrationFields<Detail, Result>): Prepared<Detail, Result> {
  const conversationId = registration.conversationId;
  const snapshot = plainCopy(registration.item, "card", new Set(), new Map()) as PermissionRequest | QuestionRequest;
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new TypeError("a pending interaction's card must be an object");
  // Read as own data only: a field the card left out is absent, whatever a
  // prototype provides.
  const kind = ownValue(snapshot, "type");
  if (kind !== "permission" && kind !== "question") throw new TypeError(`a pending interaction is a permission or a question, not ${String(kind)}`);
  const requestId = ownValue(snapshot, "requestId");
  // Any string, the empty one included: Claude Code's tool requests may
  // carry an empty id, and a reply addressed to it has always settled them.
  if (typeof requestId !== "string") throw new TypeError("a pending interaction needs a request id");
  const owner = ownValue(snapshot, "conversationId");
  if (owner !== undefined && owner !== conversationId) {
    throw new TypeError(`a pending interaction registered for ${conversationId} names ${String(owner)} as its owner`);
  }
  return { conversationId, requestId, kind, snapshot, detail: registration.detail, cancellation: registration.cancellation, abandoned: registration.abandoned };
}

/**
 * A copy of plain data, or a TypeError naming what is not. Plain data is a
 * string, any number (`Infinity`, `NaN` and `-0` included), a boolean or null; an array of plain data with no
 * holes; or an object whose prototype is `Object.prototype` or null, with
 * string keys only, whose properties are plain data or, as an absent
 * optional field, `undefined`. Every property is an enumerable data
 * property, read once from its descriptor, so no getter ever runs. A cycle
 * (a back-edge to a node still being copied) is refused; a node shared by
 * several fields is copied once, so the copy keeps the input's sharing. The
 * copy keeps key order and is made of plain objects and arrays.
 */
function plainCopy(value: unknown, path: string, ancestors: Set<object>, copied: Map<object, unknown>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "object") throw new TypeError(`${path} is not plain data (${typeof value})`);
  // A Proxy could answer every later read differently; `isProxy` runs no trap.
  if (types.isProxy(value)) throw new TypeError(`${path} is a Proxy`);
  if (ancestors.has(value)) throw new TypeError(`${path} refers back to itself`);
  // A node reached again through another field (sharing, not a cycle) reuses
  // its finished copy: each source object is read once, and the copy keeps
  // the input's sharing rather than growing into a tree.
  if (copied.has(value)) return copied.get(value);
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} is not a plain ${array ? "array" : "object"}`);
  }
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
  const keys = Reflect.ownKeys(descriptors);
  const copy: Record<string, unknown> | unknown[] = array ? [] : {};
  const length = array ? descriptors.length!.value as number : 0;
  let elements = 0;
  for (const key of keys) {
    if (typeof key === "symbol") throw new TypeError(`${path} has a symbol key`);
    if (array && key === "length") continue;
    const descriptor = descriptors[key]!;
    const at = array ? `${path}[${key}]` : `${path}.${key}`;
    if (!("value" in descriptor)) throw new TypeError(`${at} is an accessor, not data`);
    if (!descriptor.enumerable) throw new TypeError(`${at} is not enumerable`);
    // Only a canonical index below the length is an element: a key such as
    // `4294967295` is a named property.
    if (array && !(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < length)) throw new TypeError(`${at} is not an array element`);
    elements += 1;
    if (descriptor.value === undefined && array) throw new TypeError(`${at} is undefined`);
    // Defined, not assigned: assigning an own `__proto__` key (which JSON,
    // such as an MCP schema, can carry) would call the inherited setter and
    // drop it.
    Object.defineProperty(copy, key, {
      value: descriptor.value === undefined ? undefined : plainCopy(descriptor.value, at, ancestors, copied),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (array && elements !== length) throw new TypeError(`${path} has holes`);
  ancestors.delete(value);
  copied.set(value, copy);
  return copy;
}

/** A mapping's result, refused at compile time when it is a promise. */
export type Synchronous<Value> = Value extends PromiseLike<unknown> ? never : Value;

// The intrinsics a refused promise's rejection handler relies on, captured
// before any caller could replace them.
const PROMISE_THEN = Promise.prototype.then;
const PROMISE_SPECIES = Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get;

/**
 * Why a result cannot settle a request, or undefined when it can. Settling
 * resolves the agent's promise, and resolution looks up `then`, so only a
 * result whose lookup can run no code is accepted: a primitive, or an object
 * whose prototype is exactly `Object.prototype`, `Array.prototype` or null,
 * with no own `then` and none on those prototypes, and that is not itself a
 * Proxy. Everything is
 * read by descriptor or prototype identity, guarded, so no code of the
 * result's runs; anything else (a Proxy, a promise, a class instance, an
 * object inheriting from a Proxy) is refused.
 */
function thenableRefusal(value: unknown, subject = "an answer's mapping"): TypeError | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  // First, before any read a Proxy could trap: `isProxy` runs no trap, and a
  // Proxy result could hand resolution a `then` no descriptor shows.
  if (types.isProxy(value)) return new TypeError(`${subject} must not return a Proxy`);
  // A native promise is refused whatever its prototype (`isPromise` runs no
  // code); only one with the intrinsic prototype may have its rejection
  // contained.
  if (types.isPromise(value)) {
    try {
      if (Object.getPrototypeOf(value) === Promise.prototype) containRejection(value as Promise<unknown>);
    } catch { /* nothing to contain */ }
    return new TypeError(`${subject} must return its result, not a promise`);
  }
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
      return new TypeError(`${subject} must return a primitive, or a plain object or array, not an object of another kind`);
    }
    // Resolution also finds a `then` on any prototype, so the whole chain is
    // walked as it actually is: every link must be `Array.prototype` or
    // `Object.prototype`, each at most once, without a `then`.
    const seen = new Set<unknown>();
    for (let link: unknown = prototype; link !== null; link = Object.getPrototypeOf(link as object)) {
      if ((link !== Object.prototype && link !== Array.prototype) || seen.has(link)) {
        return new TypeError(`the result of ${subject} must inherit only from Array.prototype and Object.prototype`);
      }
      seen.add(link);
      if (Object.getOwnPropertyDescriptor(link as object, "then")) return new TypeError(`the result of ${subject} must not inherit a \`then\``);
    }
    const then = Object.getOwnPropertyDescriptor(value, "then");
    if (!then) return undefined;
    if (!("value" in then)) return new TypeError(`the result of ${subject} must not have a \`then\` accessor`);
    if (typeof then.value === "function") return new TypeError(`${subject} must return its result, not a promise`);
    return new TypeError(`the result of ${subject} must not have a \`then\``);
  } catch (error) {
    return new TypeError(`the result of ${subject} could not be inspected`, { cause: error });
  }
}

/**
 * Attaches a no-op rejection handler to a refused promise, through the
 * captured intrinsic `then`, only when doing so runs no code but the
 * engine's: an exact same-realm promise (its prototype is this realm's
 * `Promise.prototype`) with no own `constructor`, while
 * `Promise.prototype.constructor` is still `Promise` and the species getter
 * is still the original. Otherwise nothing is attached, and containing the
 * rejection is the caller's job.
 */
function containRejection(value: Promise<unknown>): void {
  try {
    if (Object.getOwnPropertyDescriptor(value, "constructor")) return;
    const constructor = Object.getOwnPropertyDescriptor(Promise.prototype, "constructor");
    if (!constructor || !("value" in constructor) || constructor.value !== Promise) return;
    const species = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
    if (!species || species.get === undefined || species.get !== PROMISE_SPECIES) return;
    PROMISE_THEN.call(value, undefined, () => undefined);
  } catch { /* not a promise after all: nothing to contain */ }
}

/** An own data property's value, or undefined; never runs an inherited getter. */
function ownValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

// The three parts joined without serialization hooks: the conversation id's
// length marks where it ends, the kind is one of two fixed words, and the
// request id is the rest, so distinct identities never share a key.
function pendingKey(conversationId: string, requestId: string, kind: InteractionKind): string {
  return `${conversationId.length}:${conversationId}:${kind}:${requestId}`;
}

/**
 * Subscribes to a trigger. A signal is heard twice: on the source itself, in
 * its listeners' order as it always was (so a listener added later runs after
 * the holder has cancelled), and through a dependent signal
 * (`AbortSignal.any`), whose own abort event no listener on the source can
 * suppress: it fires synchronously inside the source's `abort()`, after the
 * source's own listeners, even when one of them calls
 * `stopImmediatePropagation`. Whichever is heard first delivers the cancel,
 * a holder call like any other, queued in order; the other does nothing. An
 * abort while the listeners were attached is caught by a recheck afterwards.
 * The unsubscribe releases both listeners.
 */
function subscribe(trigger: CancellationTrigger, cancel: () => void): (() => void) | "cancelled" {
  if (typeof trigger === "function") return trigger(cancel);
  if (trigger.aborted) return "cancelled";
  let delivered = false;
  const once = () => {
    if (delivered) return;
    delivered = true;
    cancel();
  };
  const fallback = AbortSignal.any([trigger]);
  trigger.addEventListener("abort", once, { once: true });
  fallback.addEventListener("abort", once, { once: true });
  // An abort while the listeners were being attached fired before either
  // could hear it: it is delivered now, as a heard one would be. (One before
  // registration took the "cancelled" path above.)
  if (trigger.aborted) once();
  return () => {
    trigger.removeEventListener("abort", once);
    fallback.removeEventListener("abort", once);
  };
}

// A recovered card must read as the live one did: the plan and its intent
// choices, the rules an always reply would install, the dialog's context.
function pendingPermission(conversationId: string, item: PermissionRequest): PendingPermission {
  return {
    requestId: ownValue(item, "requestId"),
    conversationId,
    action: ownValue(item, "action"),
    resources: ownValue(item, "resources"),
    ...presentFields(item, ["alwaysPatterns", "diff", "plan", "choices", "sourceToolId", "mcp"]),
  } as PendingPermission;
}

function pendingQuestion(conversationId: string, item: QuestionRequest): PendingQuestion {
  return {
    requestId: ownValue(item, "requestId"),
    conversationId,
    questions: ownValue(item, "questions"),
    ...presentFields(item, ["source", "intro", "link", "schema"]),
  } as PendingQuestion;
}

// The optional fields a card sets, as own data, in this order; like every
// read of the holder's copy, never through a prototype.
function presentFields(item: object, keys: string[]): Record<string, unknown> {
  const present: Record<string, unknown> = {};
  for (const key of keys) {
    const value = ownValue(item, key);
    // Defined, not assigned: an inherited setter or getter-only field must
    // neither swallow nor refuse the value.
    if (value !== undefined) Object.defineProperty(present, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return present;
}
