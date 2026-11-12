import { describe, expect, it } from "@effect/vitest";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  type PreparedConnection,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import { type EnvironmentAuthorizationError, EnvironmentId } from "@t3tools/contracts";
import type { ForkCapabilities } from "@t3tools/fork-spaces/contracts/capabilities";
import { FORK_WS_METHODS, ForkCapabilitiesRpc } from "@t3tools/fork-spaces/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Rpc from "effect/rpc/Rpc";

import {
  createForkCapabilitiesAtomFamily,
  forkCapabilitySet,
  UPSTREAM_FORK_CAPABILITIES,
} from "./forkCapabilitiesQuery";

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

// The exit a client decodes off the socket, after the server's JSON encoding.
const exitCodec = Schema.toCodecJson(Rpc.exitSchema(ForkCapabilitiesRpc));
const overTheWire = (exit: Exit.Exit<ForkCapabilities, EnvironmentAuthorizationError>) =>
  Schema.decodeUnknownSync(exitCodec)(
    JSON.parse(JSON.stringify(Schema.encodeUnknownSync(exitCodec)(exit))),
  );
const upstreamAnswer = () =>
  overTheWire(Exit.die(`Unknown request tag: ${FORK_WS_METHODS.capabilities}`));
const forkAnswer = (capabilities: ForkCapabilities["capabilities"]) => () =>
  overTheWire(Exit.succeed({ protocolVersion: 1, capabilities }));

const makeSession = (answer: () => ReturnType<typeof overTheWire>, calls: Array<string>) =>
  ({
    client: {
      [FORK_WS_METHODS.capabilities]: () =>
        Effect.suspend(() => {
          calls.push(FORK_WS_METHODS.capabilities);
          return answer();
        }),
    },
  }) as unknown as RpcSession;

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
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
    stateChanges: () => SubscriptionRef.changes(state),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry));
  const atoms = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => atoms.dispose()));
  return {
    atom: createForkCapabilitiesAtomFamily(runtime)(ENVIRONMENT.environmentId),
    atoms,
    reconnect: (next: RpcSession) =>
      SubscriptionRef.set(sessionRef, Option.some(next)).pipe(
        Effect.andThen(SubscriptionRef.set(state, connected(2))),
      ),
  };
});

const settled = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) =>
  AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }).pipe(
    Effect.exit,
    Effect.tap(() => Effect.yieldNow),
    Effect.map(() => registry.get(atom)),
  );

describe("fork capabilities query", () => {
  it.effect("treats an upstream server's unknown-tag defect as no capabilities, once", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const harness = yield* makeHarness(makeSession(upstreamAnswer, calls));
      const unmount = harness.atoms.mount(harness.atom);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));

      const result = yield* settled(harness.atoms, harness.atom);
      expect(result).toMatchObject({ _tag: "Success", value: UPSTREAM_FORK_CAPABILITIES });
      expect(forkCapabilitySet(result).size).toBe(0);
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
      expect(calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps other failures as failures, with fork UI hidden", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        makeSession(() => overTheWire(Exit.die("socket went away")), []),
      );
      const result = yield* settled(harness.atoms, harness.atom);
      expect(AsyncResult.isFailure(result)).toBe(true);
      expect(forkCapabilitySet(result).size).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("caches per environment and asks again on reconnect", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const harness = yield* makeHarness(makeSession(upstreamAnswer, calls));
      const unmount = harness.atoms.mount(harness.atom);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));

      expect(forkCapabilitySet(yield* settled(harness.atoms, harness.atom)).size).toBe(0);
      expect(forkCapabilitySet(yield* settled(harness.atoms, harness.atom)).size).toBe(0);
      expect(calls).toHaveLength(1);

      const reconnectedCalls: Array<string> = [];
      yield* harness.reconnect(makeSession(forkAnswer(["spaces", "attention"]), reconnectedCalls));
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
      const result = yield* settled(harness.atoms, harness.atom);
      expect([...forkCapabilitySet(result)]).toEqual(["spaces", "attention"]);
      expect(calls).toHaveLength(1);
      expect(reconnectedCalls.length).toBeGreaterThan(0);
    }).pipe(Effect.scoped),
  );

  it("hides fork UI until an answer arrives", () => {
    expect(forkCapabilitySet(AsyncResult.initial()).size).toBe(0);
  });
});
