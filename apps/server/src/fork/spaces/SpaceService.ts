import type { ThreadId } from "@t3tools/contracts";
import {
  SpaceCommandRejectedError,
  SpaceServiceError,
  type Space,
  type SpaceCommand,
  type SpaceDispatchResult,
  type SpaceId,
  type SpacesSnapshot,
  type SpacesStreamItem,
} from "@t3tools/fork-spaces/contracts/space";
import {
  applySpaceEvent,
  decideSpaceCommand,
  emptySpacesState,
  spacesSnapshotFromState,
  spacesStateFromSnapshot,
  type SpacesState,
} from "@t3tools/fork-spaces/shared/spaces";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

/**
 * Spaces for one environment. Transports (fork RPC, MCP tools, turn context) call this and
 * nothing below it. Frozen at P1.0: change the interface only through the orchestrator.
 */
export class SpaceService extends Context.Service<
  SpaceService,
  {
    /** Decides and commits one command. Idempotent per `commandId`. */
    readonly dispatch: (
      command: SpaceCommand,
    ) => Effect.Effect<SpaceDispatchResult, SpaceCommandRejectedError | SpaceServiceError>;
    readonly snapshot: Effect.Effect<SpacesSnapshot, SpaceServiceError>;
    /** A snapshot, then every later space event in order. Never ends on its own. */
    readonly subscribe: Stream.Stream<SpacesStreamItem, SpaceServiceError>;
    readonly getSpace: (spaceId: SpaceId) => Effect.Effect<Option.Option<Space>, SpaceServiceError>;
    readonly spaceForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<Space>, SpaceServiceError>;
    /** Archived spaces only when asked; pinned first, then by most recent update. */
    readonly listSpaces: (options?: {
      readonly includeArchived?: boolean;
    }) => Effect.Effect<ReadonlyArray<Space>, SpaceServiceError>;
  }
>()("t3/fork/spaces/SpaceService") {}

const sortSpaces = (spaces: Iterable<Space>): ReadonlyArray<Space> =>
  [...spaces].toSorted(
    (a, b) =>
      Number(b.pinnedAt !== null) - Number(a.pinnedAt !== null) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );

/** Current state and the fork_events sequence it reflects. */
export interface SpacesView {
  readonly state: SpacesState;
  readonly sequence: number;
}

/** Events a subscriber may lag behind before its stream fails and it must resubscribe. */
const SUBSCRIBER_CAPACITY = 1024;

/**
 * Reads over `view`, plus `publish` for its writer. Writers set `view`, then publish, so a
 * subscriber sees each event once. Snapshots leave out threads `liveThreads` does not return.
 */
export const makeSpaceReads = (
  view: Ref.Ref<SpacesView>,
  liveThreads: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlySet<ThreadId>, SpaceServiceError>,
) => {
  const subscribers = new Set<Queue.Queue<SpacesStreamItem, SpaceServiceError>>();

  // Never waits: a subscriber that falls behind is failed and dropped, not waited for.
  const publish = (items: ReadonlyArray<SpacesStreamItem>) =>
    Effect.sync(() => {
      for (const queue of subscribers) {
        if (Queue.offerAllUnsafe(queue, items).length === 0) continue;
        subscribers.delete(queue);
        Queue.failCauseUnsafe(
          queue,
          Cause.fail(new SpaceServiceError({ detail: "Spaces updates fell behind." })),
        );
      }
    });

  const snapshot = Effect.gen(function* () {
    const { state, sequence } = yield* Ref.get(view);
    const live = yield* liveThreads([...state.threadSpaces.keys()]);
    const threadSpaces = new Map(
      [...state.threadSpaces].filter(([threadId]) => live.has(threadId)),
    );
    return spacesSnapshotFromState({ ...state, threadSpaces }, sequence);
  });

  const subscribe = Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Effect.acquireRelease(
        Queue.dropping<SpacesStreamItem, SpaceServiceError>(SUBSCRIBER_CAPACITY).pipe(
          Effect.tap((queue) => Effect.sync(() => subscribers.add(queue))),
        ),
        (queue) => Effect.sync(() => subscribers.delete(queue)),
      );
      const first = yield* snapshot;
      return Stream.succeed<SpacesStreamItem>({ type: "snapshot", snapshot: first }).pipe(
        Stream.concat(
          Stream.fromQueue(queue).pipe(
            Stream.filter((item) => item.type !== "event" || item.sequence > first.sequence),
          ),
        ),
      );
    }),
  );

  const getSpace = (spaceId: SpaceId) =>
    Ref.get(view).pipe(Effect.map(({ state }) => Option.fromNullishOr(state.spaces.get(spaceId))));

  // No upstream thread check: turn context calls this on every turn, for a thread that is
  // running and so exists. A deleted thread runs no turns.
  const spaceForThread = (threadId: ThreadId) =>
    Ref.get(view).pipe(
      Effect.map(({ state }) => {
        const spaceId = state.threadSpaces.get(threadId);
        return Option.fromNullishOr(spaceId === undefined ? undefined : state.spaces.get(spaceId));
      }),
    );

  const listSpaces = (listOptions?: { readonly includeArchived?: boolean }) =>
    Ref.get(view).pipe(
      Effect.map(({ state }) =>
        sortSpaces(
          [...state.spaces.values()].filter(
            (space) => listOptions?.includeArchived === true || space.archivedAt === null,
          ),
        ),
      ),
    );

  return { publish, reads: { snapshot, subscribe, getSpace, spaceForThread, listSpaces } };
};

/**
 * In-memory SpaceService for tests of code that depends on it (MCP tools, turn context). Uses
 * the shared decider and reducer, so it behaves like the real service except for persistence,
 * idempotency across restarts, and thread-existence checks (every thread id is accepted, and
 * shown in snapshots, unless listed in `missingThreadIds`).
 */
export const layerMemory = (options?: {
  readonly initial?: SpacesSnapshot;
  readonly missingThreadIds?: ReadonlyArray<ThreadId>;
}) =>
  Layer.effect(
    SpaceService,
    Effect.gen(function* () {
      const missing = new Set(options?.missingThreadIds ?? []);
      const state = yield* Ref.make<SpacesView>({
        state:
          options?.initial === undefined
            ? emptySpacesState
            : spacesStateFromSnapshot(options.initial),
        sequence: options?.initial?.sequence ?? 0,
      });
      const { publish, reads } = makeSpaceReads(state, (threadIds) =>
        Effect.succeed(new Set(threadIds.filter((threadId) => !missing.has(threadId)))),
      );
      const seen = new Map<string, SpaceDispatchResult>();

      const dispatch = Effect.fn("SpaceService.memory.dispatch")(function* (command: SpaceCommand) {
        const previous = seen.get(command.commandId);
        if (previous !== undefined) return previous;
        if (
          command.type === "thread.space.set" &&
          command.spaceId !== null &&
          missing.has(command.threadId)
        ) {
          return yield* new SpaceCommandRejectedError({
            commandId: command.commandId,
            reason: "thread_not_found",
            detail: command.threadId,
          });
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const current = yield* Ref.get(state);
        const decision = decideSpaceCommand(current.state, command, now);
        if (decision._tag === "rejected") {
          return yield* new SpaceCommandRejectedError({
            commandId: command.commandId,
            reason: decision.reason,
            detail: decision.detail,
          });
        }
        const items: Array<SpacesStreamItem> = [];
        let next = current;
        for (const event of decision.events) {
          next = { state: applySpaceEvent(next.state, event), sequence: next.sequence + 1 };
          items.push({ type: "event", sequence: next.sequence, event });
        }
        // View first, then publish: see makeSpaceReads.
        yield* Ref.set(state, next);
        yield* publish(items);
        const result = { sequence: next.sequence };
        seen.set(command.commandId, result);
        return result;
      });

      return SpaceService.of({ dispatch, ...reads });
    }),
  );
