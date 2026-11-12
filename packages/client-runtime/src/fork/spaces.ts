import { CommandId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import type { ForkCapabilities } from "@t3tools/fork-spaces/contracts/capabilities";
import { FORK_WS_METHODS } from "@t3tools/fork-spaces/contracts/rpc";
import { SpaceId, type SpaceCommand } from "@t3tools/fork-spaces/contracts/space";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { isAuthorizationFailure, isRpcClientError } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  type AtomCommandFailure,
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  createRuntimeCommand,
  followStreamInEnvironment,
} from "../state/runtime.ts";
import { forkCapabilitySet } from "./capabilities.ts";
import {
  type EnvironmentSpace,
  environmentSpaceLists,
  type EnvironmentSpaces,
  LOADING_SPACES,
  mergedSpaceLists,
  reduceEnvironmentSpaces,
  type SpaceLists,
  type SpacesSyncEnded,
  type SpacesSyncInput,
  spacesStateOf,
  UNAVAILABLE_SPACES,
} from "./spaceState.ts";
import type { SpacesState } from "@t3tools/fork-spaces/shared/spaces";

type Command<Type extends SpaceCommand["type"]> = Extract<SpaceCommand, { readonly type: Type }>;
type Fields<Type extends SpaceCommand["type"]> = Omit<Command<Type>, "type" | "commandId">;

/**
 * Builds the commands for `fork.spaces.dispatch`. Each call takes a fresh command id from
 * `newId` (the platform's UUID); to retry a user action, dispatch the same command again so the
 * server's receipt makes the retry a no-op.
 */
export function createSpaceCommandBuilders(newId: () => string) {
  const commandId = () => CommandId.make(newId());
  return {
    /** Without a `spaceId`, the space gets a fresh one, readable from the command. */
    create: (
      fields: Omit<Fields<"space.create">, "spaceId"> & { readonly spaceId?: SpaceId },
    ): Command<"space.create"> => ({
      ...fields,
      type: "space.create",
      commandId: commandId(),
      spaceId: fields.spaceId ?? SpaceId.make(newId()),
    }),
    update: (fields: Fields<"space.update">): Command<"space.update"> => ({
      ...fields,
      type: "space.update",
      commandId: commandId(),
    }),
    pin: (spaceId: SpaceId, pinned: boolean): Command<"space.update"> => ({
      type: "space.update",
      commandId: commandId(),
      spaceId,
      pinned,
    }),
    archive: (spaceId: SpaceId): Command<"space.archive"> => ({
      type: "space.archive",
      commandId: commandId(),
      spaceId,
    }),
    unarchive: (spaceId: SpaceId): Command<"space.unarchive"> => ({
      type: "space.unarchive",
      commandId: commandId(),
      spaceId,
    }),
    delete: (spaceId: SpaceId): Command<"space.delete"> => ({
      type: "space.delete",
      commandId: commandId(),
      spaceId,
    }),
    /** `spaceId: null` takes the thread out of its space. */
    moveThread: (threadId: ThreadId, spaceId: SpaceId | null): Command<"thread.space.set"> => ({
      type: "thread.space.set",
      commandId: commandId(),
      threadId,
      spaceId,
    }),
  };
}

const failureMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

const isTransportFailure = (cause: Cause.Cause<unknown>) =>
  cause.reasons.length > 0 &&
  cause.reasons.every((reason) => reason._tag === "Fail" && isRpcClientError(reason.error));

const STOPPED: SpacesSyncEnded = { type: "ended", failure: null };

const endedBy = (cause: Cause.Cause<unknown>): SpacesSyncEnded => {
  if (isTransportFailure(cause) || Cause.hasInterruptsOnly(cause)) return STOPPED;
  return {
    type: "ended",
    failure: { message: failureMessage(cause), retrying: !isAuthorizationFailure(cause) },
  };
};

const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 30_000;

/**
 * Any end but an authorization error resubscribes on the same session after a capped backoff
 * that a snapshot resets. The supervisor replaces a session only when its socket closes, so a
 * stream's `RpcClientError` can leave it in place; an authorization error waits for a new one.
 */
const sessionItems = (session: RpcSession): Stream.Stream<SpacesSyncInput> => {
  let failures = 0;
  const attempt = (): Stream.Stream<SpacesSyncInput> => {
    let ended: SpacesSyncEnded = STOPPED;
    return Stream.suspend(() => session.client[FORK_WS_METHODS.spacesSubscribe]({})).pipe(
      Stream.tap((item) =>
        Effect.sync(() => {
          if (item.type === "snapshot") failures = 0;
        }),
      ),
      Stream.catchCause((cause) => {
        ended = endedBy(cause);
        return Stream.empty;
      }),
      Stream.concat(
        Stream.suspend(() => {
          const end = Stream.succeed<SpacesSyncInput>(ended);
          if (ended.failure !== null && !ended.failure.retrying) return end;
          const delay = Math.min(RETRY_BASE_MS * 2 ** failures, RETRY_CAP_MS);
          failures += 1;
          return end.pipe(
            Stream.concat(Stream.fromEffect(Effect.sleep(delay)).pipe(Stream.drain)),
            Stream.concat(Stream.suspend(attempt)),
          );
        }),
      ),
    );
  };
  return attempt();
};

// A new session is not live until its snapshot arrives.
const supervisedSpaces = Stream.unwrap(
  EnvironmentSupervisor.EnvironmentSupervisor.pipe(
    Effect.map((supervisor) =>
      SubscriptionRef.changes(supervisor.session).pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.succeed<SpacesSyncInput>(STOPPED),
            onSome: (session) =>
              Stream.succeed<SpacesSyncInput>(STOPPED).pipe(Stream.concat(sessionItems(session))),
          }),
        ),
        Stream.scan(() => LOADING_SPACES, reduceEnvironmentSpaces),
        Stream.changes,
      ),
    ),
  ),
);

// A removed environment shows loading again rather than its last mirror.
const followSpaces = (environmentId: EnvironmentId) =>
  Stream.unwrap(
    EnvironmentRegistry.EnvironmentRegistry.pipe(
      Effect.map((registry) =>
        SubscriptionRef.changes(registry.entries).pipe(
          Stream.map((entries) => entries.has(environmentId)),
          Stream.changes,
          Stream.switchMap((registered) =>
            registered
              ? followStreamInEnvironment(environmentId, supervisedSpaces)
              : Stream.make(LOADING_SPACES),
          ),
        ),
      ),
    ),
  );

/**
 * `sequence` is the server's after the command. `caughtUp` is false when the wait ended before
 * local state reached it: the subscription stopped being live, the environment was removed, or
 * the fallback timeout passed. The command applied either way.
 */
export interface SpaceDispatchOutcome {
  readonly sequence: number;
  readonly caughtUp: boolean;
}

const CATCH_UP_TIMEOUT = "10 seconds";

type CatchUp = "waiting" | "caughtUp" | "behind";

// Loading before the first ready state is the first snapshot on its way; after it, the
// environment was removed.
const catchUpStep = (sequence: number, seenReady: boolean, spaces: EnvironmentSpaces): CatchUp => {
  switch (spaces.status) {
    case "ready":
      if (spaces.sequence >= sequence) return "caughtUp";
      return spaces.live ? "waiting" : "behind";
    case "loading":
      return seenReady ? "behind" : "waiting";
    case "failed":
    case "unavailable":
      return "behind";
  }
};

/** Sorts once per state change; the same state keeps the same lists. */
const memoizeOnState = <Key, A>(compute: (key: Key) => A) => {
  let last: { readonly key: Key; readonly value: A } | undefined;
  return (key: Key): A => {
    if (last === undefined || last.key !== key) last = { key, value: compute(key) };
    return last.value;
  };
};

type EnvironmentState = { readonly environmentId: EnvironmentId; readonly state: SpacesState };

const sameStates = (
  left: ReadonlyArray<EnvironmentState>,
  right: ReadonlyArray<EnvironmentState>,
) =>
  left.length === right.length &&
  left.every(
    (entry, index) =>
      entry.environmentId === right[index]!.environmentId && entry.state === right[index]!.state,
  );

/**
 * Spaces for every environment. `capabilities` is the environment's fork capabilities query
 * (`createForkCapabilitiesAtomFamily`); `fork.spaces.subscribe` runs only where it includes
 * "spaces", so an upstream server sees nothing beyond the capabilities request.
 * `environmentIds` lists the environments whose spaces `mergedLists` merges, in a stable order.
 */
export function createSpacesAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  options: {
    readonly capabilities: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<AsyncResult.AsyncResult<ForkCapabilities, unknown>>;
    readonly environmentIds: Atom.Atom<ReadonlyArray<EnvironmentId>>;
  },
) {
  const live = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(followSpaces(environmentId))
      .pipe(Atom.withLabel(`environment-data:fork:spaces-live:${environmentId}`)),
  );
  const spaces = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): EnvironmentSpaces => {
      const capabilities = get(options.capabilities(environmentId));
      if (AsyncResult.isInitial(capabilities)) return LOADING_SPACES;
      if (!forkCapabilitySet(capabilities).has("spaces")) return UNAVAILABLE_SPACES;
      return AsyncResult.getOrElse(get(live(environmentId)), () => LOADING_SPACES);
    }).pipe(Atom.withLabel(`environment-data:fork:spaces:${environmentId}`)),
  );

  /** One environment's spaces, sorted as `environmentSpaceLists`. */
  const lists = Atom.family((environmentId: EnvironmentId) => {
    const sorted = memoizeOnState(environmentSpaceLists);
    return Atom.make((get) => sorted(spacesStateOf(get(spaces(environmentId))))).pipe(
      Atom.withLabel(`environment-data:fork:space-lists:${environmentId}`),
    );
  });

  let lastMerged:
    | {
        readonly states: ReadonlyArray<EnvironmentState>;
        readonly value: SpaceLists<EnvironmentSpace>;
      }
    | undefined;
  /** Every environment's spaces in one list, sorted as `mergedSpaceLists`. */
  const mergedLists = Atom.make((get) => {
    const states = get(options.environmentIds).map((environmentId) => ({
      environmentId,
      state: spacesStateOf(get(spaces(environmentId))),
    }));
    if (lastMerged === undefined || !sameStates(lastMerged.states, states)) {
      lastMerged = { states, value: mergedSpaceLists(states) };
    }
    return lastMerged.value;
  }).pipe(Atom.withLabel("environment-data:fork:space-lists:merged"));

  // Every command in one environment applies in the order it was made, so a create reaches the
  // server before a move into the new space. The lane holds only the request; the catch-up wait
  // runs outside it, so a slow stream does not hold back the next command.
  const send = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:fork:spaces:dispatch",
    tag: FORK_WS_METHODS.spacesDispatch,
    concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
  });
  const catchUp = createRuntimeCommand(runtime, {
    label: "environment-data:fork:spaces:catch-up",
    execute: (
      target: { readonly environmentId: EnvironmentId; readonly sequence: number },
      registry,
    ) =>
      AtomRegistry.toStream(registry, spaces(target.environmentId)).pipe(
        Stream.mapAccum(
          () => false,
          (seenReady, current) => {
            const step = catchUpStep(target.sequence, seenReady, current);
            return [seenReady || current.status === "ready", [step]] as const;
          },
        ),
        Stream.filter((step) => step !== "waiting"),
        Stream.runHead,
        Effect.timeoutOption(CATCH_UP_TIMEOUT),
        Effect.map((step) => Option.getOrUndefined(Option.flatten(step)) === "caughtUp"),
      ),
  });

  /**
   * Sends a command; resolves with `SpaceDispatchOutcome` once local state has caught up, or
   * fails as the RPC does (`SpaceCommandRejectedError` and the rest) without waiting.
   */
  type SendFailure = AtomCommandFailure<Awaited<ReturnType<typeof send.run>>>;
  const dispatch = {
    label: send.label,
    requiredScopes: send.requiredScopes,
    permissionAtom: send.permissionAtom,
    run: async (
      registry: AtomRegistry.AtomRegistry,
      target: { readonly environmentId: EnvironmentId; readonly input: SpaceCommand },
    ): Promise<AtomCommandResult<SpaceDispatchOutcome, SendFailure>> => {
      const sent = await send.run(registry, target);
      if (!AsyncResult.isSuccess(sent)) return AsyncResult.failure(sent.cause);
      const { sequence } = sent.value;
      const waited = await catchUp.run(registry, { environmentId: target.environmentId, sequence });
      return AsyncResult.success({
        sequence,
        caughtUp: AsyncResult.isSuccess(waited) && waited.value,
      });
    },
  };

  return { spaces, lists, mergedLists, dispatch };
}
