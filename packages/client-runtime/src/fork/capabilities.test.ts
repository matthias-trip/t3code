import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, RpcScopeAuthorization, WsRpcGroup } from "@t3tools/contracts";
import type { ForkCapabilities } from "@t3tools/fork-spaces/contracts/capabilities";
import { FORK_WS_METHODS, ForkRpcGroup } from "@t3tools/fork-spaces/contracts/rpc";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
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
import {
  createForkCapabilitiesAtomFamily,
  forkCapabilitySet,
  UPSTREAM_FORK_CAPABILITIES,
} from "./capabilities.ts";

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

/**
 * Connects the app's merged-group client to `server` through JSON text frames, the way the
 * environment socket does. Records what crossed the wire in both directions.
 */
const connect = Effect.fn("TestForkCapabilities.connect")(function* (
  server: Effect.Effect<never, never, RpcServer.Protocol>,
) {
  const serialization = yield* RpcSerialization.RpcSerialization;
  const overTheWire = <A>(message: unknown) => {
    const parser = serialization.makeUnsafe();
    return parser.decode(parser.encode(message)!) as ReadonlyArray<A>;
  };
  const requests: Array<RpcMessage.RequestEncoded> = [];
  const frames: Array<RpcMessage.FromServerEncoded> = [];
  const peers: {
    toServer?: (clientId: number, message: RpcMessage.FromClientEncoded) => Effect.Effect<void>;
    toClient?: (clientId: number, message: RpcMessage.FromServerEncoded) => Effect.Effect<void>;
  } = {};

  const serverProtocol = yield* RpcServer.Protocol.make((write) => {
    peers.toServer = write;
    return Effect.gen(function* () {
      return {
        disconnects: yield* Queue.unbounded<number>(),
        send: (clientId, response) =>
          Effect.forEach(
            overTheWire<RpcMessage.FromServerEncoded>(response),
            (frame) => {
              frames.push(frame);
              return peers.toClient!(clientId, frame);
            },
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
    client,
    session: { client } as unknown as RpcSession,
    sent: (tag: string) => requests.filter((request) => request.tag === tag).length,
    // A connection-level defect fails every call on the socket.
    connectionDefects: () => frames.filter((frame) => frame._tag === "Defect").length,
  };
});

// apps/server serves the environment socket with these options (WS_RPC_SERVER_OPTIONS), upstream
// and fork alike: a handler defect fails that call only.
const SERVER_OPTIONS = { disableFatalDefects: true } as const;

// A plain upstream T3 Code server: the upstream group and its tag table, nothing fork.
const upstreamMake = RpcServer.make(WsRpcGroup, SERVER_OPTIONS);
// An unknown tag never reaches a handler or middleware, so the server gets none.
const noUpstreamHandlers = Context.empty() as Context.Context<
  Exclude<Effect.Services<typeof upstreamMake>, RpcServer.Protocol>
>;
const upstreamServer = upstreamMake.pipe(Effect.provide(noUpstreamHandlers));

const forkServer = (answer: () => Effect.Effect<ForkCapabilities>) =>
  RpcServer.make(ForkRpcGroup, SERVER_OPTIONS).pipe(
    Effect.provide(
      Layer.merge(
        ForkRpcGroup.toLayer({ [FORK_WS_METHODS.capabilities]: answer }),
        Layer.succeed(RpcScopeAuthorization)((effect) => effect),
      ),
    ),
  );

const makeHarness = Effect.fn("TestForkCapabilities.makeHarness")(function* (session: RpcSession) {
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
      // The query runs on the test clock, so TestClock.adjust reaches any retry it schedules.
      Layer.succeed(Clock.Clock, yield* Clock.Clock),
    ),
  );
  const atoms = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => atoms.dispose()));
  const atom = createForkCapabilitiesAtomFamily(runtime)(ENVIRONMENT.environmentId);
  const unmount = atoms.mount(atom);
  yield* Effect.addFinalizer(() => Effect.sync(unmount));
  return {
    settled: AtomRegistry.getResult(atoms, atom, { suspendOnWaiting: true }).pipe(
      Effect.exit,
      Effect.map(() => atoms.get(atom)),
    ),
    // Like the supervisor: drop the session, reconnect, then report connected.
    reconnect: (next: RpcSession) =>
      Effect.all([
        SubscriptionRef.set(state, { ...connected(1), phase: "connecting" as const }),
        SubscriptionRef.set(sessionRef, Option.none()),
        SubscriptionRef.set(sessionRef, Option.some(next)),
        SubscriptionRef.set(state, connected(2)),
      ]),
  };
});

describe("fork capabilities query", () => {
  it.effect("treats a real upstream server's unknown-tag answer as no capabilities, once", () =>
    Effect.gen(function* () {
      const upstream = yield* connect(upstreamServer);
      const harness = yield* makeHarness(upstream.session);

      const result = yield* harness.settled;
      expect(result).toMatchObject({ _tag: "Success", value: UPSTREAM_FORK_CAPABILITIES });
      expect(forkCapabilitySet(result).size).toBe(0);
      yield* TestClock.adjust(PAST_ANY_RETRY);
      expect(upstream.sent(FORK_WS_METHODS.capabilities)).toBe(1);
      expect(upstream.connectionDefects()).toBe(0);
    }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
  );

  it.effect("hides fork UI on any other failure, without retrying or hurting the socket", () =>
    Effect.gen(function* () {
      let answers = 0;
      const fork = yield* connect(
        forkServer(() =>
          answers++ === 0
            ? // What a reworded Effect unknown-tag defect would look like.
              Effect.die(`Unknown tag: ${FORK_WS_METHODS.capabilities}`)
            : Effect.succeed({ protocolVersion: 1, capabilities: ["spaces"] }),
        ),
      );
      const harness = yield* makeHarness(fork.session);

      const result = yield* harness.settled;
      expect(AsyncResult.isFailure(result)).toBe(true);
      expect(forkCapabilitySet(result).size).toBe(0);
      yield* TestClock.adjust(PAST_ANY_RETRY);
      expect(fork.sent(FORK_WS_METHODS.capabilities)).toBe(1);
      expect(fork.connectionDefects()).toBe(0);
      // The same socket still answers.
      expect(yield* fork.client[FORK_WS_METHODS.capabilities]({})).toEqual({
        protocolVersion: 1,
        capabilities: ["spaces"],
      });
    }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
  );

  it.effect("caches per environment and asks again on reconnect", () =>
    Effect.gen(function* () {
      const upstream = yield* connect(upstreamServer);
      const harness = yield* makeHarness(upstream.session);

      expect(forkCapabilitySet(yield* harness.settled).size).toBe(0);
      yield* TestClock.adjust(PAST_ANY_RETRY);
      expect(forkCapabilitySet(yield* harness.settled).size).toBe(0);
      expect(upstream.sent(FORK_WS_METHODS.capabilities)).toBe(1);

      const asked = yield* Deferred.make<void>();
      const fork = yield* connect(
        forkServer(() =>
          Deferred.succeed(asked, undefined).pipe(
            Effect.as({ protocolVersion: 1, capabilities: ["spaces", "attention"] }),
          ),
        ),
      );
      yield* harness.reconnect(fork.session);
      yield* Deferred.await(asked);
      expect([...forkCapabilitySet(yield* harness.settled)]).toEqual(["spaces", "attention"]);
      expect(upstream.sent(FORK_WS_METHODS.capabilities)).toBe(1);
      expect(fork.sent(FORK_WS_METHODS.capabilities)).toBe(1);
    }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
  );

  it("hides fork UI until an answer arrives", () => {
    expect(forkCapabilitySet(AsyncResult.initial()).size).toBe(0);
  });
});
