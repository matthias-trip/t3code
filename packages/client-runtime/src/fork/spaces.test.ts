import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  RpcScopeAuthorization,
  WsRpcGroup,
} from "@t3tools/contracts";
import { FORK_WS_METHODS, ForkRpcGroup } from "@t3tools/fork-spaces/contracts/rpc";
import {
  SpaceCommandRejectedError,
  SpaceId,
  SpaceServiceError,
  type SpaceCommand,
  type SpaceEvent,
  type SpacesSnapshot,
  type SpacesStreamItem,
} from "@t3tools/fork-spaces/contracts/space";
import {
  fixtureSpaceIds,
  fixtureSpacesSnapshot,
  fixtureThreadIds,
} from "@t3tools/fork-spaces/shared/spaceFixtures";
import {
  applySpaceEvent,
  decideSpaceCommand,
  spacesSnapshotFromState,
  spacesStateFromSnapshot,
} from "@t3tools/fork-spaces/shared/spaces";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  RpcClient,
  RpcClientError,
  type RpcMessage,
  RpcSerialization,
  RpcServer,
} from "effect/rpc";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { makeWsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createForkCapabilitiesAtomFamily } from "./capabilities.ts";
import { createSpaceCommandBuilders, createSpacesAtoms } from "./spaces.ts";
import type { EnvironmentSpaces } from "./spaceState.ts";

const ENVIRONMENT = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("fork-env"),
  label: "Fork environment",
  httpBaseUrl: "https://fork.example.test",
  wsBaseUrl: "wss://fork.example.test",
});

const connected = (generation: number): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation,
});

// Longer than any retry or backoff a failed query could schedule.
const PAST_ANY_RETRY = "1 hour";

// Events about this space leave the server as an event type this client does not know yet.
const FUTURE_SPACE_ID = SpaceId.make("space:from-the-future");

type Frame = RpcMessage.FromServerEncoded;

const asFutureEvent = (frame: Frame): Frame => {
  if (frame._tag !== "Chunk") return frame;
  return {
    ...frame,
    values: frame.values.map((value) => {
      const item = value as { type: string; event?: { type: string; spaceId?: string } };
      return item.type === "event" && item.event?.spaceId === FUTURE_SPACE_ID
        ? { ...item, event: { type: "space.reshaped", spaceId: FUTURE_SPACE_ID } }
        : value;
    }) as unknown as typeof frame.values,
  };
};

/**
 * Connects the app's merged-group client to `server` through JSON text frames, the way the
 * environment socket does. Records the requests that crossed the wire. `afterReply` runs once a
 * request's reply has reached the client.
 */
const connect = Effect.fn("TestForkSpaces.connect")(function* (
  server: Effect.Effect<never, never, RpcServer.Protocol>,
  afterReply: (tag: string) => Effect.Effect<void> = () => Effect.void,
) {
  const serialization = yield* RpcSerialization.RpcSerialization;
  const overTheWire = <A>(message: unknown) => {
    const parser = serialization.makeUnsafe();
    return parser.decode(parser.encode(message)!) as ReadonlyArray<A>;
  };
  const requests: Array<RpcMessage.RequestEncoded> = [];
  const peers: {
    toServer?: (clientId: number, message: RpcMessage.FromClientEncoded) => Effect.Effect<void>;
    toClient?: (clientId: number, message: Frame) => Effect.Effect<void>;
  } = {};

  const serverProtocol = yield* RpcServer.Protocol.make((write) => {
    peers.toServer = write;
    return Effect.gen(function* () {
      return {
        disconnects: yield* Queue.unbounded<number>(),
        send: (clientId, response) =>
          Effect.forEach(
            overTheWire<Frame>(response),
            (frame) =>
              peers.toClient!(clientId, asFutureEvent(frame)).pipe(
                Effect.andThen(() => {
                  if (frame._tag !== "Exit") return Effect.void;
                  const request = requests.find((sent) => sent.id === frame.requestId);
                  return request === undefined ? Effect.void : afterReply(request.tag);
                }),
              ),
            { discard: true },
          ),
        end: () => Effect.void,
        clientIds: Effect.succeed(new Set([0])),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: false,
        supportsNotifications: true,
        codecFor: serialization.codecFor,
      };
    });
  });
  const clientProtocol = yield* RpcClient.Protocol.make((write) => {
    peers.toClient = write;
    return Effect.succeed({
      send: (clientId, request) =>
        Effect.forEach(
          overTheWire<RpcMessage.FromClientEncoded>(request),
          (message) => {
            if (message._tag === "Request") requests.push(message);
            return peers.toServer!(clientId, message);
          },
          { discard: true },
        ),
      supportsAck: true,
      supportsTransferables: false,
      codecFor: serialization.codecFor,
    });
  });

  yield* server.pipe(Effect.provideService(RpcServer.Protocol, serverProtocol), Effect.forkScoped);
  const client = yield* makeWsRpcProtocolClient.pipe(
    Effect.provideService(RpcClient.Protocol, clientProtocol),
  );
  return {
    session: { client } as unknown as RpcSession,
    sent: (tag: string) => requests.filter((request) => request.tag === tag).length,
  };
});

const SERVER_OPTIONS = { disableFatalDefects: true } as const;

const upstreamMake = RpcServer.make(WsRpcGroup, SERVER_OPTIONS);
const noUpstreamHandlers = Context.empty() as Context.Context<
  Exclude<Effect.Services<typeof upstreamMake>, RpcServer.Protocol>
>;
const upstreamServer = upstreamMake.pipe(Effect.provide(noUpstreamHandlers));

type SubscribeError = SpaceServiceError | EnvironmentAuthorizationError;

/**
 * Subscriptions send a snapshot, then what the test offers. Dispatch runs the real decider and
 * answers a seen command id from its receipt. `holdEvents` waits for `releaseEvents`;
 * `refuseSubscriptions` fails the next ones in turn; `firstDispatchTakes` delays the first command.
 */
const makeForkServer = Effect.fn("TestForkSpaces.makeForkServer")(function* (
  snapshot: SpacesSnapshot,
  options: {
    readonly holdEvents?: boolean;
    readonly refuseSubscriptions?: ReadonlyArray<SubscribeError>;
    readonly firstDispatchTakes?: Duration.Input;
  } = {},
) {
  const newStream = () => Queue.unbounded<SpacesStreamItem, SubscribeError | Cause.Done>();
  let items = yield* newStream();
  const held: Array<SpacesStreamItem> = [];
  const refusals = [...(options.refuseSubscriptions ?? [])];
  // When each subscription arrived, by the test clock.
  const subscribed = yield* Queue.unbounded<number>();
  const dispatched: Array<SpaceCommand> = [];
  const receipts = new Map<string, number>();
  let state = spacesStateFromSnapshot(snapshot);
  let sequence = snapshot.sequence;
  const offerEvent = (eventSequence: number, event: SpaceEvent) =>
    Queue.offer(items, { type: "event", sequence: eventSequence, event });

  const arrived = yield* Queue.unbounded<SpaceCommand>();
  const dispatch = (command: SpaceCommand) =>
    Effect.gen(function* () {
      yield* Queue.offer(arrived, command);
      dispatched.push(command);
      if (dispatched.length === 1 && options.firstDispatchTakes !== undefined) {
        yield* Effect.sleep(options.firstDispatchTakes);
      }
      const receipt = receipts.get(command.commandId);
      if (receipt !== undefined) return { sequence: receipt };
      const decision = decideSpaceCommand(state, command, "2026-11-12T10:00:00.000Z");
      if (decision._tag === "rejected") {
        return yield* new SpaceCommandRejectedError({
          commandId: command.commandId,
          reason: decision.reason,
          detail: decision.detail,
        });
      }
      for (const event of decision.events) {
        state = applySpaceEvent(state, event);
        sequence += 1;
        if (options.holdEvents) held.push({ type: "event", sequence, event });
        else yield* offerEvent(sequence, event);
      }
      receipts.set(command.commandId, sequence);
      return { sequence };
    });

  // Ends or fails the open subscription; a later one gets a fresh stream.
  const closeStream = (close: (queue: typeof items) => Effect.Effect<boolean>) =>
    Effect.gen(function* () {
      const current = items;
      items = yield* newStream();
      yield* close(current);
    });

  const subscribe = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* Queue.offer(subscribed, yield* Clock.currentTimeMillis);
        const refusal = refusals.shift();
        if (refusal !== undefined) return Stream.fail(refusal);
        const item: SpacesStreamItem = {
          type: "snapshot",
          snapshot: spacesSnapshotFromState(state, sequence),
        };
        return Stream.make(item).pipe(Stream.concat(Stream.fromQueue(items)));
      }),
    );

  const server = RpcServer.make(ForkRpcGroup, SERVER_OPTIONS).pipe(
    Effect.provide(
      Layer.merge(
        ForkRpcGroup.toLayer({
          [FORK_WS_METHODS.capabilities]: () =>
            Effect.succeed({ protocolVersion: 1, capabilities: ["spaces"] }),
          [FORK_WS_METHODS.spacesDispatch]: dispatch,
          [FORK_WS_METHODS.spacesSnapshot]: () =>
            Effect.succeed(spacesSnapshotFromState(state, sequence)),
          [FORK_WS_METHODS.spacesSubscribe]: subscribe,
        }),
        Layer.succeed(RpcScopeAuthorization)((effect) => effect),
      ),
    ),
  );
  return {
    server,
    offerEvent,
    dispatched,
    arrived,
    subscribed,
    releaseEvents: Effect.suspend(() =>
      Queue.offerAll(items, held.splice(0, held.length)).pipe(Effect.asVoid),
    ),
    endStream: closeStream(Queue.end),
    failStream: (error: SubscribeError) => closeStream((queue) => Queue.fail(queue, error)),
  };
});

const makeHarness = Effect.fn("TestForkSpaces.makeHarness")(function* (session: RpcSession) {
  const state = yield* SubscriptionRef.make(connected(1));
  const sessionRef = yield* SubscriptionRef.make(Option.some(session));
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: ENVIRONMENT,
    state,
    session: sessionRef,
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  type Registry = EnvironmentRegistry.EnvironmentRegistry["Service"];
  const run: Registry["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: Registry["followStream"] = (_environmentId, stream) =>
    Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map([[ENVIRONMENT.environmentId, {} as ConnectionCatalogEntry]]),
  );
  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries,
    run,
    followStream,
    stateChanges: () => SubscriptionRef.changes(state),
  } as unknown as Registry);
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry),
      Layer.succeed(Clock.Clock, yield* Clock.Clock),
    ),
  );
  const atoms = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => atoms.dispose()));
  const spaceAtoms = createSpacesAtoms(runtime, {
    capabilities: createForkCapabilitiesAtomFamily(runtime),
    environmentIds: Atom.make([ENVIRONMENT.environmentId]),
  });
  const atom = spaceAtoms.spaces(ENVIRONMENT.environmentId);
  const listsAtom = spaceAtoms.lists(ENVIRONMENT.environmentId);
  const unmount = [atoms.mount(atom), atoms.mount(listsAtom)];
  yield* Effect.addFinalizer(() => Effect.sync(() => unmount.forEach((stop) => stop())));
  return {
    current: () => atoms.get(atom),
    lists: () => atoms.get(listsAtom),
    remove: SubscriptionRef.set(entries, new Map()),
    until: (done: (spaces: EnvironmentSpaces) => boolean) =>
      AtomRegistry.toStream(atoms, atom).pipe(
        Stream.filter(done),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      ),
    dispatch: (command: SpaceCommand) =>
      Effect.promise(() =>
        spaceAtoms.dispatch.run(atoms, {
          environmentId: ENVIRONMENT.environmentId,
          input: command,
        }),
      ),
    reconnect: (next: RpcSession) =>
      Effect.all([
        SubscriptionRef.set(state, { ...connected(1), phase: "connecting" as const }),
        SubscriptionRef.set(sessionRef, Option.none()),
        SubscriptionRef.set(sessionRef, Option.some(next)),
        SubscriptionRef.set(state, connected(2)),
      ]),
  };
});

const atSequence = (sequence: number) => (spaces: EnvironmentSpaces) =>
  spaces.status === "ready" && spaces.live && spaces.sequence === sequence;

const notLive = (spaces: EnvironmentSpaces) => spaces.status === "ready" && !spaces.live;

const serviceError = new SpaceServiceError({ detail: "Space store is unavailable." });
const authorizationError = new EnvironmentAuthorizationError({
  message: "Not allowed to read spaces.",
  requiredScope: AuthOrchestrationReadScope,
});

const sequentialIds = () => {
  let ids = 0;
  return () => `id-${++ids}`;
};

const outcome = <A>(result: AsyncResult.AsyncResult<A, unknown>): A => {
  if (!AsyncResult.isSuccess(result)) throw new Error("Expected the dispatch to succeed.");
  return result.value;
};

const withWire = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped);

const readyState = (spaces: EnvironmentSpaces) => {
  if (spaces.status !== "ready") throw new Error(`Expected ready spaces, got ${spaces.status}.`);
  return spaces.state;
};

const deleted = (spaceId: SpaceId): SpaceEvent => ({ type: "space.deleted", spaceId });

describe("spaces state", () => {
  it.effect("mirrors the snapshot, applies newer events, skips stale and unknown ones", () =>
    Effect.gen(function* () {
      const fork = yield* makeForkServer(fixtureSpacesSnapshot);
      const connection = yield* connect(fork.server);
      const harness = yield* makeHarness(connection.session);

      const initial = readyState(yield* harness.until(atSequence(12)));
      expect([...initial.spaces.keys()]).toEqual(fixtureSpacesSnapshot.spaces.map((s) => s.id));
      expect(initial.threadSpaces.get(fixtureThreadIds.banner)).toBe(fixtureSpaceIds.payments);

      // Not newer than the snapshot: ignored.
      yield* fork.offerEvent(12, deleted(fixtureSpaceIds.payments));
      yield* fork.offerEvent(11, deleted(fixtureSpaceIds.onboarding));
      // An event type from a newer server: skipped, the stream goes on.
      yield* fork.offerEvent(13, deleted(FUTURE_SPACE_ID));
      yield* fork.offerEvent(14, deleted(fixtureSpaceIds.archived));

      const latest = readyState(yield* harness.until(atSequence(14)));
      expect([...latest.spaces.keys()]).toEqual([
        fixtureSpaceIds.payments,
        fixtureSpaceIds.onboarding,
      ]);
      expect(latest.threadSpaces.get(fixtureThreadIds.banner)).toBe(fixtureSpaceIds.payments);
      expect(connection.sent(FORK_WS_METHODS.spacesSubscribe)).toBe(1);
    }).pipe(withWire),
  );

  it.effect("subscribes again on a new session and takes its snapshot", () =>
    Effect.gen(function* () {
      const first = yield* makeForkServer(fixtureSpacesSnapshot);
      const firstConnection = yield* connect(first.server);
      const harness = yield* makeHarness(firstConnection.session);
      yield* harness.until(atSequence(12));
      yield* first.offerEvent(13, deleted(fixtureSpaceIds.archived));
      yield* harness.until(atSequence(13));

      // The new server's history differs: its snapshot replaces everything.
      const second = yield* makeForkServer({
        sequence: 3,
        spaces: fixtureSpacesSnapshot.spaces.filter((s) => s.id === fixtureSpaceIds.onboarding),
        threadSpaces: [],
      });
      const secondConnection = yield* connect(second.server);
      yield* harness.reconnect(secondConnection.session);

      const replaced = readyState(yield* harness.until(atSequence(3)));
      expect([...replaced.spaces.keys()]).toEqual([fixtureSpaceIds.onboarding]);
      expect(replaced.threadSpaces.size).toBe(0);
      yield* second.offerEvent(4, deleted(fixtureSpaceIds.onboarding));
      expect(readyState(yield* harness.until(atSequence(4))).spaces.size).toBe(0);
      expect(firstConnection.sent(FORK_WS_METHODS.spacesSubscribe)).toBe(1);
      expect(secondConnection.sent(FORK_WS_METHODS.spacesSubscribe)).toBe(1);
    }).pipe(withWire),
  );

  it.effect("reports an upstream server as unavailable without asking it for spaces", () =>
    Effect.gen(function* () {
      const upstream = yield* connect(upstreamServer);
      const harness = yield* makeHarness(upstream.session);

      expect(yield* harness.until((spaces) => spaces.status !== "loading")).toEqual({
        status: "unavailable",
      });
      yield* TestClock.adjust(PAST_ANY_RETRY);
      expect(harness.current()).toEqual({ status: "unavailable" });
      expect(upstream.sent(FORK_WS_METHODS.capabilities)).toBe(1);
      expect(upstream.sent(FORK_WS_METHODS.spacesSubscribe)).toBe(0);
    }).pipe(withWire),
  );

  it.effect("dispatch resolves once local state has the change; a retry reuses its id", () =>
    Effect.gen(function* () {
      const fork = yield* makeForkServer(fixtureSpacesSnapshot);
      const connection = yield* connect(fork.server);
      const harness = yield* makeHarness(connection.session);
      yield* harness.until(atSequence(12));
      const commands = createSpaceCommandBuilders(sequentialIds());

      const create = commands.create({ title: "Billing export" });
      expect(outcome(yield* harness.dispatch(create))).toEqual({ sequence: 13, caughtUp: true });
      const created = readyState(harness.current()).spaces.get(create.spaceId);
      expect(created?.title).toBe("Billing export");

      // The same action again: same command id, answered from the receipt, no second space.
      expect(outcome(yield* harness.dispatch(create))).toEqual({ sequence: 13, caughtUp: true });
      expect(new Set([create.commandId, create.spaceId]).size).toBe(2);
      expect(readyState(harness.current()).spaces.size).toBe(
        fixtureSpacesSnapshot.spaces.length + 1,
      );
    }).pipe(withWire),
  );

  it.effect("sends one environment's commands in the order they were made", () =>
    Effect.gen(function* () {
      const fork = yield* makeForkServer(fixtureSpacesSnapshot, { firstDispatchTakes: "1 second" });
      const connection = yield* connect(fork.server);
      const harness = yield* makeHarness(connection.session);
      yield* harness.until(atSequence(12));
      const commands = createSpaceCommandBuilders(sequentialIds());

      // The move names the space the create makes: the server rejects it if it arrives while
      // the create is still running.
      const create = commands.create({ title: "Billing export" });
      const move = commands.moveThread(fixtureThreadIds.unfiled, create.spaceId);
      const both = yield* Effect.all([harness.dispatch(create), harness.dispatch(move)], {
        concurrency: "unbounded",
      }).pipe(Effect.forkChild);
      expect((yield* Queue.take(fork.arrived)).commandId).toBe(create.commandId);
      yield* TestClock.adjust("1 second");
      const [created, moved] = yield* Fiber.join(both);
      expect(outcome(created).caughtUp).toBe(true);
      expect(outcome(moved).caughtUp).toBe(true);
      expect(fork.dispatched.map((command) => command.commandId)).toEqual([
        create.commandId,
        move.commandId,
      ]);
      const after = readyState(harness.current());
      expect(after.threadSpaces.get(fixtureThreadIds.unfiled)).toBe(create.spaceId);
    }).pipe(withWire),
  );

  it.effect("dispatch waits for an event that arrives after the reply", () =>
    Effect.gen(function* () {
      const fork = yield* makeForkServer(fixtureSpacesSnapshot, { holdEvents: true });
      const connection = yield* connect(fork.server, (tag) =>
        tag === FORK_WS_METHODS.spacesDispatch ? fork.releaseEvents : Effect.void,
      );
      const harness = yield* makeHarness(connection.session);
      yield* harness.until(atSequence(12));
      const create = createSpaceCommandBuilders(sequentialIds()).create({
        title: "Billing export",
      });

      expect(outcome(yield* harness.dispatch(create))).toEqual({ sequence: 13, caughtUp: true });
      // Read as the dispatch resolves: the event sent after the reply is already applied.
      expect(readyState(harness.current()).spaces.get(create.spaceId)?.title).toBe(
        "Billing export",
      );
    }).pipe(withWire),
  );

  it.effect("dispatch stops waiting when the stream ends before its event", () =>
    Effect.gen(function* () {
      const fork = yield* makeForkServer(fixtureSpacesSnapshot, { holdEvents: true });
      const connection = yield* connect(fork.server, (tag) =>
        tag === FORK_WS_METHODS.spacesDispatch ? fork.endStream : Effect.void,
      );
      const harness = yield* makeHarness(connection.session);
      yield* harness.until(atSequence(12));
      const create = createSpaceCommandBuilders(sequentialIds()).create({
        title: "Billing export",
      });

      // The test clock never moves, so neither the fallback timeout nor a resubscribe can help.
      expect(outcome(yield* harness.dispatch(create))).toEqual({ sequence: 13, caughtUp: false });
      const spaces = harness.current();
      expect(notLive(spaces)).toBe(true);
      expect(readyState(spaces).spaces.has(create.spaceId)).toBe(false);
    }).pipe(withWire),
  );

  it.effect("a rejected command fails with the rejection and does not wait", () =>
    Effect.gen(function* () {
      const fork = yield* makeForkServer(fixtureSpacesSnapshot);
      const connection = yield* connect(fork.server);
      const harness = yield* makeHarness(connection.session);
      yield* harness.until(atSequence(12));
      const commands = createSpaceCommandBuilders(sequentialIds());

      const result = yield* harness.dispatch(commands.archive(SpaceId.make("space:missing")));
      if (AsyncResult.isSuccess(result)) throw new Error("Expected the dispatch to fail.");
      expect(Cause.squash(result.cause)).toBeInstanceOf(SpaceCommandRejectedError);
      expect(harness.current()).toMatchObject({ status: "ready", sequence: 12, live: true });
    }).pipe(withWire),
  );

  it.effect("a service error before any snapshot retries with growing backoff", () =>
    Effect.gen(function* () {
      const fork = yield* makeForkServer(fixtureSpacesSnapshot, {
        refuseSubscriptions: [serviceError, serviceError],
      });
      const connection = yield* connect(fork.server);
      const harness = yield* makeHarness(connection.session);

      const first = yield* Queue.take(fork.subscribed);
      expect(yield* harness.until((spaces) => spaces.status === "failed")).toEqual({
        status: "failed",
        message: serviceError.message,
        retrying: true,
      });
      yield* TestClock.adjust("1 second");
      const second = yield* Queue.take(fork.subscribed);
      yield* TestClock.adjust("2 seconds");
      const third = yield* Queue.take(fork.subscribed);
      expect([second - first, third - first]).toEqual([1_000, 3_000]);
      yield* harness.until(atSequence(12));
      expect(connection.sent(FORK_WS_METHODS.spacesSubscribe)).toBe(3);
    }).pipe(withWire),
  );

  it.effect("a service error after a snapshot keeps the state, not live, and retries", () =>
    Effect.gen(function* () {
      const fork = yield* makeForkServer(fixtureSpacesSnapshot);
      const connection = yield* connect(fork.server);
      const harness = yield* makeHarness(connection.session);
      const first = yield* Queue.take(fork.subscribed);
      yield* harness.until(atSequence(12));
      const lists = harness.lists();

      yield* fork.failStream(serviceError);
      expect(yield* harness.until(notLive)).toMatchObject({ status: "ready", sequence: 12 });
      // Same state, same sorted lists.
      expect(harness.lists()).toBe(lists);
      yield* TestClock.adjust("1 second");
      const second = yield* Queue.take(fork.subscribed);
      yield* harness.until(atSequence(12));

      // The snapshot reset the backoff: the next failure waits one second again.
      yield* fork.failStream(serviceError);
      yield* harness.until(notLive);
      yield* TestClock.adjust("1 second");
      const third = yield* Queue.take(fork.subscribed);
      expect([second - first, third - first]).toEqual([1_000, 2_000]);
      yield* harness.until(atSequence(12));
    }).pipe(withWire),
  );

  it.effect("an authorization error before a snapshot fails without retrying", () =>
    Effect.gen(function* () {
      const fork = yield* makeForkServer(fixtureSpacesSnapshot, {
        refuseSubscriptions: [authorizationError],
      });
      const connection = yield* connect(fork.server);
      const harness = yield* makeHarness(connection.session);

      expect(yield* harness.until((spaces) => spaces.status === "failed")).toEqual({
        status: "failed",
        message: authorizationError.message,
        retrying: false,
      });
      yield* TestClock.adjust(PAST_ANY_RETRY);
      expect(connection.sent(FORK_WS_METHODS.spacesSubscribe)).toBe(1);
    }).pipe(withWire),
  );

  it.effect("an authorization error after a snapshot stops being live without retrying", () =>
    Effect.gen(function* () {
      const fork = yield* makeForkServer(fixtureSpacesSnapshot);
      const connection = yield* connect(fork.server);
      const harness = yield* makeHarness(connection.session);
      yield* harness.until(atSequence(12));

      yield* fork.failStream(authorizationError);
      yield* harness.until(notLive);
      yield* TestClock.adjust(PAST_ANY_RETRY);
      expect(notLive(harness.current())).toBe(true);
      expect(connection.sent(FORK_WS_METHODS.spacesSubscribe)).toBe(1);
    }).pipe(withWire),
  );

  // The supervisor replaces a session only when its socket closes, so a transport error on one
  // stream can leave the session in place; the subscription retries on it.
  it.effect("a transport error that keeps the session resubscribes on it after a backoff", () =>
    Effect.gen(function* () {
      const fork = yield* makeForkServer(fixtureSpacesSnapshot);
      const connection = yield* connect(fork.server);
      const failedOnce = yield* Deferred.make<void>();
      const client = connection.session.client;
      let calls = 0;
      const session = {
        client: new Proxy(client, {
          get: (target, key, receiver) =>
            key !== FORK_WS_METHODS.spacesSubscribe || calls > 0
              ? Reflect.get(target, key, receiver)
              : () => {
                  calls += 1;
                  Deferred.doneUnsafe(failedOnce, Effect.void);
                  return Stream.fail(
                    new RpcClientError.RpcClientError({
                      reason: new RpcClientError.RpcClientDefect({
                        message: "Frame could not be read.",
                        cause: null,
                      }),
                    }),
                  );
                },
        }),
      } as unknown as RpcSession;
      const harness = yield* makeHarness(session);

      yield* Deferred.await(failedOnce);
      expect(harness.current()).toEqual({ status: "loading" });
      yield* TestClock.adjust("1 second");
      yield* harness.until(atSequence(12));
      expect(connection.sent(FORK_WS_METHODS.spacesSubscribe)).toBe(1);
    }).pipe(withWire),
  );

  it.effect("a removed environment goes back to loading", () =>
    Effect.gen(function* () {
      const fork = yield* makeForkServer(fixtureSpacesSnapshot);
      const connection = yield* connect(fork.server);
      const harness = yield* makeHarness(connection.session);
      yield* harness.until(atSequence(12));

      yield* harness.remove;
      expect(yield* harness.until((spaces) => spaces.status === "loading")).toEqual({
        status: "loading",
      });
    }).pipe(withWire),
  );
});
