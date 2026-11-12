import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, RpcScopeAuthorization, WsRpcGroup } from "@t3tools/contracts";
import { FORK_WS_METHODS, ForkRpcGroup } from "@t3tools/fork-spaces/contracts/rpc";
import {
  SpaceCommandRejectedError,
  SpaceId,
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
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { RpcClient, type RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "../connection/model.ts";
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
 * environment socket does. Records the requests that crossed the wire.
 */
const connect = Effect.fn("TestForkSpaces.connect")(function* (
  server: Effect.Effect<never, never, RpcServer.Protocol>,
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
            (frame) => peers.toClient!(clientId, asFutureEvent(frame)),
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

/**
 * A fork server whose subscription sends `snapshot` and then whatever the test offers. Dispatch
 * runs the real decider and streams the resulting events; a command id seen before is answered
 * from its receipt, like the server's event store.
 */
const makeForkServer = Effect.fn("TestForkSpaces.makeForkServer")(function* (
  snapshot: SpacesSnapshot,
) {
  const items = yield* Queue.unbounded<SpacesStreamItem>();
  const dispatched: Array<SpaceCommand> = [];
  const receipts = new Map<string, number>();
  let state = spacesStateFromSnapshot(snapshot);
  let sequence = snapshot.sequence;
  const offerEvent = (eventSequence: number, event: SpaceEvent) =>
    Queue.offer(items, { type: "event", sequence: eventSequence, event });

  const dispatch = (command: SpaceCommand) =>
    Effect.gen(function* () {
      dispatched.push(command);
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
        yield* offerEvent(sequence, event);
      }
      receipts.set(command.commandId, sequence);
      return { sequence };
    });

  const server = RpcServer.make(ForkRpcGroup, SERVER_OPTIONS).pipe(
    Effect.provide(
      Layer.merge(
        ForkRpcGroup.toLayer({
          [FORK_WS_METHODS.capabilities]: () =>
            Effect.succeed({ protocolVersion: 1, capabilities: ["spaces"] }),
          [FORK_WS_METHODS.spacesDispatch]: dispatch,
          [FORK_WS_METHODS.spacesSnapshot]: () =>
            Effect.succeed(spacesSnapshotFromState(state, sequence)),
          [FORK_WS_METHODS.spacesSubscribe]: () =>
            Stream.make({ type: "snapshot", snapshot } as SpacesStreamItem).pipe(
              Stream.concat(Stream.fromQueue(items)),
            ),
        }),
        Layer.succeed(RpcScopeAuthorization)((effect) => effect),
      ),
    ),
  );
  return { server, offerEvent, dispatched };
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
  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
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
  });
  const atom = spaceAtoms.spaces(ENVIRONMENT.environmentId);
  const unmount = atoms.mount(atom);
  yield* Effect.addFinalizer(() => Effect.sync(unmount));
  return {
    current: () => atoms.get(atom),
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
  spaces.status === "ready" && spaces.sequence === sequence;

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
    }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
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
    }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
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
    }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
  );

  it.effect("dispatch resolves once local state has the change; a retry reuses its id", () =>
    Effect.gen(function* () {
      const fork = yield* makeForkServer(fixtureSpacesSnapshot);
      const connection = yield* connect(fork.server);
      const harness = yield* makeHarness(connection.session);
      yield* harness.until(atSequence(12));
      let ids = 0;
      const commands = createSpaceCommandBuilders(() => `id-${++ids}`);

      const create = commands.create({ title: "Billing export" });
      const result = yield* harness.dispatch(create);
      expect(AsyncResult.isSuccess(result)).toBe(true);
      const created = readyState(harness.current()).spaces.get(create.spaceId);
      expect(created?.title).toBe("Billing export");

      // The same action again: same command id, answered from the receipt, no second space.
      expect(AsyncResult.isSuccess(yield* harness.dispatch(create))).toBe(true);
      const move = commands.moveThread(fixtureThreadIds.unfiled, create.spaceId);
      yield* harness.dispatch(move);
      expect(fork.dispatched.map((command) => command.commandId)).toEqual([
        create.commandId,
        create.commandId,
        move.commandId,
      ]);
      expect(new Set([create.commandId, create.spaceId, move.commandId]).size).toBe(3);
      const after = readyState(harness.current());
      expect(after.spaces.size).toBe(fixtureSpacesSnapshot.spaces.length + 1);
      expect(after.threadSpaces.get(fixtureThreadIds.unfiled)).toBe(create.spaceId);
    }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
  );
});
