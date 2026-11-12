import type { ThreadId } from "@t3tools/contracts";
import {
  Space,
  SpaceCommandRejectedError,
  SpaceEvent,
  SpaceServiceError,
  type SpaceCommand,
  type SpaceCommandRejectionReason,
  type SpaceDispatchResult,
  type SpaceId,
  type SpacesStreamItem,
} from "@t3tools/fork-spaces/contracts/space";
import {
  applySpaceEvent,
  decideSpaceCommand,
  emptySpacesState,
  type SpacesState,
} from "@t3tools/fork-spaces/shared/spaces";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import {
  ForkEventStore,
  type ForkCommandIdConflictError,
  type ForkStoredEvent,
} from "../persistence/ForkEventStore.ts";
import { makeSpaceReads, SpaceService, type SpacesView } from "./SpaceService.ts";

const decodeEvent = Schema.decodeUnknownEffect(SpaceEvent);
const encodeEvent = Schema.encodeEffect(SpaceEvent);
const encodeIconJson = Schema.encodeEffect(Schema.fromJsonString(Space.fields.icon));
const encodeDefaultsJson = Schema.encodeEffect(Schema.fromJsonString(Space.fields.defaults));

/** fork_events types this service owns; other fork event types are not replayed here. */
const spaceEventTypes: Record<SpaceEvent["type"], true> = {
  "space.created": true,
  "space.updated": true,
  "space.deleted": true,
  "thread.space-updated": true,
};

const REPLAY_PAGE_SIZE = 500;

/** Logs the cause; clients get no storage internals. */
const storageFailure = (cause: unknown) =>
  Effect.logError("Spaces storage failed", cause).pipe(
    Effect.andThen(
      Effect.fail(new SpaceServiceError({ detail: "Spaces could not be read or saved." })),
    ),
  );

const streamIdOf = (event: SpaceEvent): string => {
  switch (event.type) {
    case "space.created":
    case "space.updated":
      return `space:${event.space.id}`;
    case "space.deleted":
      return `space:${event.spaceId}`;
    case "thread.space-updated":
      return `thread-space:${event.threadId}`;
  }
};

const projectSpace = Effect.fnUntraced(function* (space: Space) {
  const sql = yield* SqlClient.SqlClient;
  const iconJson = space.icon === null ? null : yield* encodeIconJson(space.icon);
  const defaultsJson = yield* encodeDefaultsJson(space.defaults);
  yield* sql`
    INSERT INTO fork_spaces (
      space_id, title, brief, icon_json, defaults_json, pinned_at, archived_at,
      created_at, updated_at
    ) VALUES (
      ${space.id}, ${space.title}, ${space.brief},
      ${iconJson}, ${defaultsJson}, ${space.pinnedAt}, ${space.archivedAt},
      ${space.createdAt}, ${space.updatedAt}
    )
    ON CONFLICT (space_id) DO UPDATE SET
      title = excluded.title, brief = excluded.brief, icon_json = excluded.icon_json,
      defaults_json = excluded.defaults_json, pinned_at = excluded.pinned_at,
      archived_at = excluded.archived_at, created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `;
  yield* sql`DELETE FROM fork_space_projects WHERE space_id = ${space.id}`;
  for (const [position, projectId] of space.projectIds.entries()) {
    yield* sql`
      INSERT INTO fork_space_projects (space_id, project_id, position)
      VALUES (${space.id}, ${projectId}, ${position})
    `;
  }
});

const projectThreadSpace = Effect.fnUntraced(function* (
  threadId: ThreadId,
  spaceId: SpaceId | null,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* spaceId === null
    ? sql`DELETE FROM fork_thread_spaces WHERE thread_id = ${threadId}`
    : sql`
        INSERT INTO fork_thread_spaces (thread_id, space_id)
        VALUES (${threadId}, ${spaceId})
        ON CONFLICT (thread_id) DO UPDATE SET space_id = excluded.space_id
      `;
});

const projectEvent = Effect.fnUntraced(function* (event: SpaceEvent) {
  const sql = yield* SqlClient.SqlClient;
  switch (event.type) {
    case "space.created":
    case "space.updated":
      return yield* projectSpace(event.space);
    case "space.deleted":
      yield* sql`DELETE FROM fork_thread_spaces WHERE space_id = ${event.spaceId}`;
      yield* sql`DELETE FROM fork_space_projects WHERE space_id = ${event.spaceId}`;
      yield* sql`DELETE FROM fork_spaces WHERE space_id = ${event.spaceId}`;
      return;
    case "thread.space-updated":
      return yield* projectThreadSpace(event.threadId, event.spaceId);
  }
});

const unavailable = new SpaceServiceError({ detail: "Spaces could not be loaded." });

/** Every call fails: startup could not load spaces, and the rest of the server still runs. */
const failUnavailable = () => Effect.fail(unavailable);
const unavailableService = SpaceService.of({
  dispatch: failUnavailable,
  snapshot: failUnavailable(),
  subscribe: Stream.fail(unavailable),
  getSpace: failUnavailable,
  spaceForThread: failUnavailable,
  listSpaces: failUnavailable,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ForkEventStore;
  const projections = yield* ProjectionStoreV2;

  // fork_events is the record. Memory is its replay; an event that no longer decodes is
  // skipped rather than stopping the server.
  const replay = Effect.gen(function* () {
    let state: SpacesState = emptySpacesState;
    let sequence = 0;
    while (true) {
      const rows = yield* store.readAfter({ afterSequence: sequence, limit: REPLAY_PAGE_SIZE });
      for (const row of rows) {
        sequence = row.sequence;
        if (!Object.hasOwn(spaceEventTypes, row.type)) continue;
        const event = yield* decodeEvent(row.payload).pipe(Effect.option);
        if (Option.isNone(event)) {
          yield* Effect.logWarning("Skipping a space event that does not decode").pipe(
            Effect.annotateLogs({ sequence: row.sequence, type: row.type }),
          );
          continue;
        }
        state = applySpaceEvent(state, event.value);
      }
      if (rows.length < REPLAY_PAGE_SIZE) return { state, sequence } satisfies SpacesView;
    }
  });

  // The projection tables are always derived from the events: rebuilt from the replay.
  const rebuildProjections = (state: SpacesState) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM fork_thread_spaces`;
        yield* sql`DELETE FROM fork_space_projects`;
        yield* sql`DELETE FROM fork_spaces`;
        for (const space of state.spaces.values()) yield* projectSpace(space);
        for (const [threadId, spaceId] of state.threadSpaces) {
          yield* projectThreadSpace(threadId, spaceId);
        }
      }),
    );

  const loaded = yield* replay.pipe(
    Effect.tap(({ state }) => rebuildProjections(state)),
    Effect.exit,
  );
  if (Exit.isFailure(loaded)) {
    yield* Effect.logError(
      "Spaces could not be loaded; they stay unavailable until restart",
      loaded.cause,
    );
    return unavailableService;
  }

  // Reads come from memory: the decider needs the whole state on every dispatch, and turn
  // context reads a thread's space on every turn. This service is the only writer of space
  // events, so memory changes only after a commit succeeds, under `lock`.
  const view = yield* Ref.make<SpacesView>(loaded.value);
  const lock = yield* Semaphore.make(1);

  const liveThreads = (threadIds: ReadonlyArray<ThreadId>) =>
    projections.getThreadTitles(threadIds).pipe(
      Effect.map(
        (titles): ReadonlySet<ThreadId> =>
          new Set(threadIds.filter((threadId) => Object.hasOwn(titles, threadId))),
      ),
      Effect.catch(storageFailure),
    );
  const { publish, reads } = makeSpaceReads(view, liveThreads);

  const dispatchLocked = Effect.fnUntraced(function* (command: SpaceCommand) {
    const acceptedAt = yield* DateTime.now;
    const rejection = (reason: SpaceCommandRejectionReason, detail: string) =>
      new SpaceCommandRejectedError({ commandId: command.commandId, reason, detail });
    const commandIdReused = (storedCommandType: string) =>
      rejection("invalid", `command id already used by ${storedCommandType}`);

    // A retry can be rejected where the original was accepted (its space now exists, or its
    // thread was since deleted). Such a retry returns the original result.
    const rejectUnlessCommitted = (reason: SpaceCommandRejectionReason, detail: string) =>
      store.receipt(command.commandId).pipe(
        Effect.catch(storageFailure),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(rejection(reason, detail)),
            onSome: (receipt) =>
              receipt.commandType === command.type
                ? Effect.succeed<SpaceDispatchResult>({ sequence: receipt.resultSequence })
                : Effect.fail(commandIdReused(receipt.commandType)),
          }),
        ),
      );

    // Removing a thread from its space needs no live thread: a deleted one must still leave.
    if (
      command.type === "thread.space.set" &&
      command.spaceId !== null &&
      !(yield* liveThreads([command.threadId])).has(command.threadId)
    ) {
      return yield* rejectUnlessCommitted("thread_not_found", command.threadId);
    }

    const current = yield* Ref.get(view);
    const decision = decideSpaceCommand(current.state, command, DateTime.formatIso(acceptedAt));
    if (decision._tag === "rejected") {
      return yield* rejectUnlessCommitted(decision.reason, decision.detail);
    }

    // The decider produced these events, so failing to encode one is a bug.
    const encoded = yield* Effect.forEach(decision.events, (event) =>
      encodeEvent(event).pipe(
        Effect.map((payload) => ({
          streamId: streamIdOf(event),
          type: event.type,
          payload,
          occurredAt: acceptedAt,
        })),
      ),
    ).pipe(Effect.orDie);

    // Uninterruptible from the commit on: memory must follow a commit that went through.
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const decoded: Array<{ readonly stored: ForkStoredEvent; readonly event: SpaceEvent }> = [];
        const result = yield* store
          .commit({
            commandId: command.commandId,
            commandType: command.type,
            acceptedAt,
            events: encoded,
            // Projects what was stored, decoded as a replay would, so memory matches the store.
            project: (stored) =>
              Effect.forEach(stored, (row) =>
                decodeEvent(row.payload).pipe(
                  Effect.tap((event) => Effect.sync(() => decoded.push({ stored: row, event }))),
                  Effect.flatMap(projectEvent),
                ),
              ),
          })
          .pipe(
            Effect.catchTags({
              ForkCommandIdConflictError: (error: ForkCommandIdConflictError) =>
                Effect.fail(commandIdReused(error.storedCommandType)),
              ForkEventStoreWriteError: storageFailure,
              SchemaError: storageFailure,
            }),
          );

        if (result.committed && decoded.length > 0) {
          let next = current;
          const items: Array<SpacesStreamItem> = [];
          for (const { stored, event } of decoded) {
            next = { state: applySpaceEvent(next.state, event), sequence: stored.sequence };
            items.push({ type: "event", sequence: stored.sequence, event });
          }
          // View first, then publish: see makeSpaceReads.
          yield* Ref.set(view, next);
          yield* publish(items);
        }
        return { sequence: result.receipt.resultSequence } satisfies SpaceDispatchResult;
      }),
    );
  });

  const dispatch = Effect.fn("SpaceService.dispatch")(function* (command: SpaceCommand) {
    yield* Effect.annotateCurrentSpan({ "fork.command.type": command.type });
    return yield* lock.withPermits(1)(dispatchLocked(command));
  });

  return SpaceService.of({ dispatch, ...reads });
});

/**
 * Persisted SpaceService: events in fork_events, replayed into memory and re-projected into
 * the fork_spaces tables at startup.
 */
export const layer = Layer.effect(SpaceService, make);
