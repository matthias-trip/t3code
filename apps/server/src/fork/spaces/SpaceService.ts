import type { ThreadId } from "@t3tools/contracts";
import {
  SpaceCommandRejectedError,
  type Space,
  type SpaceCommand,
  type SpaceDispatchResult,
  type SpaceId,
  type SpaceServiceError,
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
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
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

/**
 * In-memory SpaceService for tests of code that depends on it (MCP tools, turn context). Uses
 * the shared decider and reducer, so it behaves like the real service except for persistence,
 * idempotency across restarts, and thread-existence checks (every thread id is accepted unless
 * listed in `missingThreadIds`).
 */
export const layerMemory = (options?: {
  readonly initial?: SpacesSnapshot;
  readonly missingThreadIds?: ReadonlyArray<ThreadId>;
}) =>
  Layer.effect(
    SpaceService,
    Effect.gen(function* () {
      const missing = new Set(options?.missingThreadIds ?? []);
      const state = yield* Ref.make<{ readonly state: SpacesState; readonly sequence: number }>({
        state:
          options?.initial === undefined
            ? emptySpacesState
            : spacesStateFromSnapshot(options.initial),
        sequence: options?.initial?.sequence ?? 0,
      });
      const events = yield* PubSub.unbounded<SpacesStreamItem>();
      const seen = new Map<string, SpaceDispatchResult>();

      const dispatch = Effect.fn("SpaceService.memory.dispatch")(function* (command: SpaceCommand) {
        const previous = seen.get(command.commandId);
        if (previous !== undefined) return previous;
        if (command.type === "thread.space.set" && missing.has(command.threadId)) {
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
        let next = current;
        for (const event of decision.events) {
          next = { state: applySpaceEvent(next.state, event), sequence: next.sequence + 1 };
          yield* PubSub.publish(events, { type: "event", sequence: next.sequence, event });
        }
        yield* Ref.set(state, next);
        const result = { sequence: next.sequence };
        seen.set(command.commandId, result);
        return result;
      });

      const snapshot = Ref.get(state).pipe(
        Effect.map(({ state, sequence }) => spacesSnapshotFromState(state, sequence)),
      );

      const subscribe = Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(events);
          const first = yield* snapshot;
          return Stream.succeed<SpacesStreamItem>({ type: "snapshot", snapshot: first }).pipe(
            Stream.concat(
              Stream.fromSubscription(subscription).pipe(
                Stream.filter((item) => item.type !== "event" || item.sequence > first.sequence),
              ),
            ),
          );
        }),
      );

      const getSpace = (spaceId: SpaceId) =>
        Ref.get(state).pipe(
          Effect.map(({ state }) => Option.fromNullishOr(state.spaces.get(spaceId))),
        );

      const spaceForThread = (threadId: ThreadId) =>
        Ref.get(state).pipe(
          Effect.map(({ state }) => {
            const spaceId = state.threadSpaces.get(threadId);
            return Option.fromNullishOr(
              spaceId === undefined ? undefined : state.spaces.get(spaceId),
            );
          }),
        );

      const listSpaces = (listOptions?: { readonly includeArchived?: boolean }) =>
        Ref.get(state).pipe(
          Effect.map(({ state }) =>
            sortSpaces(
              [...state.spaces.values()].filter(
                (space) => listOptions?.includeArchived === true || space.archivedAt === null,
              ),
            ),
          ),
        );

      return SpaceService.of({
        dispatch,
        snapshot,
        subscribe,
        getSpace,
        spaceForThread,
        listSpaces,
      });
    }),
  );
