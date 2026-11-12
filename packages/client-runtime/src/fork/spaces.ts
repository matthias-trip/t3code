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

import type * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { isRpcClientError } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createEnvironmentRpcCommand, followStreamInEnvironment } from "../state/runtime.ts";
import { forkCapabilitySet } from "./capabilities.ts";
import {
  type EnvironmentSpaces,
  LOADING_SPACES,
  reduceEnvironmentSpaces,
  type SpacesSyncInput,
  UNAVAILABLE_SPACES,
} from "./spaceState.ts";

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

// Every subscription starts with a snapshot, so a new session just subscribes again. A lost
// transport waits for that session; any other failure is reported and also waits for it.
const sessionItems = (session: RpcSession): Stream.Stream<SpacesSyncInput> =>
  session.client[FORK_WS_METHODS.spacesSubscribe]({}).pipe(
    Stream.catchCause((cause) =>
      isTransportFailure(cause)
        ? Stream.empty
        : Stream.make({ type: "failed" as const, message: failureMessage(cause) }),
    ),
  );

const followSpaces = (environmentId: EnvironmentId) =>
  followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      EnvironmentSupervisor.EnvironmentSupervisor.pipe(
        Effect.map((supervisor) =>
          SubscriptionRef.changes(supervisor.session).pipe(
            Stream.switchMap(Option.match({ onNone: () => Stream.empty, onSome: sessionItems })),
            Stream.scan(() => LOADING_SPACES, reduceEnvironmentSpaces),
          ),
        ),
      ),
    ),
  );

// A dispatch resolves once local state has caught up, so a caller can read what it changed.
const CATCH_UP_TIMEOUT = "10 seconds";

/**
 * Spaces for every environment. `capabilities` is the environment's fork capabilities query
 * (`createForkCapabilitiesAtomFamily`); `fork.spaces.subscribe` runs only where it includes
 * "spaces", so an upstream server sees nothing beyond the capabilities request.
 */
export function createSpacesAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  options: {
    readonly capabilities: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<AsyncResult.AsyncResult<ForkCapabilities, unknown>>;
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

  const dispatch = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:fork:spaces:dispatch",
    tag: FORK_WS_METHODS.spacesDispatch,
    // Commands on one space, or one thread's membership, apply in the order they were made.
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }) =>
        JSON.stringify([
          environmentId,
          input.type === "thread.space.set" ? input.threadId : input.spaceId,
        ]),
    },
    onSuccess: ({ environmentId }, registry, result) =>
      AtomRegistry.toStream(registry, spaces(environmentId)).pipe(
        Stream.filter(
          (current) =>
            current.status !== "loading" &&
            (current.status !== "ready" || current.sequence >= result.sequence),
        ),
        Stream.runHead,
        Effect.timeoutOption(CATCH_UP_TIMEOUT),
        Effect.asVoid,
      ),
  });

  return { spaces, dispatch };
}
