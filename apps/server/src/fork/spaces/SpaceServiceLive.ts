import type { ThreadId } from "@t3tools/contracts";
import {
  Space,
  SpaceCommandRejectedError,
  SpaceEvent,
  SpaceServiceError,
  ThreadSpace,
  type SpaceCommand,
  type SpaceCommandRejectionReason,
  type SpaceDispatchResult,
  type SpacesStreamItem,
} from "@t3tools/fork-spaces/contracts/space";
import {
  applySpaceEvent,
  decideSpaceCommand,
  spacesStateFromSnapshot,
} from "@t3tools/fork-spaces/shared/spaces";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import {
  ForkEventStore,
  type ForkCommandIdConflictError,
  type ForkStoredEvent,
} from "../persistence/ForkEventStore.ts";
import { makeSpaceReads, SpaceService, type SpacesView } from "./SpaceService.ts";

const decodeSpaces = Schema.decodeUnknownEffect(Schema.Array(Schema.fromJsonString(Space)));
const decodeThreadSpaces = Schema.decodeUnknownEffect(Schema.Array(ThreadSpace));
const decodeEvent = Schema.decodeUnknownEffect(SpaceEvent);
const encodeEvent = Schema.encodeEffect(SpaceEvent);
const encodeIconJson = Schema.encodeEffect(Schema.fromJsonString(Space.fields.icon));
const encodeDefaultsJson = Schema.encodeEffect(Schema.fromJsonString(Space.fields.defaults));

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
      return event.space.id;
    case "space.deleted":
      return event.spaceId;
    case "thread.space-updated":
      return event.threadId;
  }
};

/** Ends the receipt probe's transaction, rolling back the receipt it reserved. */
class NotCommitted extends Schema.TaggedError<NotCommitted>()("NotCommitted", {}) {}

const projectEvent = Effect.fnUntraced(function* (event: SpaceEvent) {
  const sql = yield* SqlClient.SqlClient;
  switch (event.type) {
    case "space.created":
    case "space.updated": {
      const { space } = event;
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
      return;
    }
    case "space.deleted":
      yield* sql`DELETE FROM fork_thread_spaces WHERE space_id = ${event.spaceId}`;
      yield* sql`DELETE FROM fork_space_projects WHERE space_id = ${event.spaceId}`;
      yield* sql`DELETE FROM fork_spaces WHERE space_id = ${event.spaceId}`;
      return;
    case "thread.space-updated":
      yield* event.spaceId === null
        ? sql`DELETE FROM fork_thread_spaces WHERE thread_id = ${event.threadId}`
        : sql`
            INSERT INTO fork_thread_spaces (thread_id, space_id)
            VALUES (${event.threadId}, ${event.spaceId})
            ON CONFLICT (thread_id) DO UPDATE SET space_id = excluded.space_id
          `;
      return;
  }
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ForkEventStore;
  const projections = yield* ProjectionStoreV2;

  // Reads come from memory: the decider needs the whole state on every dispatch, and turn
  // context reads a thread's space on every turn. This service is the only writer of space
  // events, so memory changes only after a commit succeeds, under `lock`.
  const loadView = Effect.gen(function* () {
    const spaceRows = yield* sql<{ readonly space: string }>`
      SELECT json_object(
        'id', s.space_id, 'title', s.title, 'brief', s.brief, 'icon', json(s.icon_json),
        'projectIds', (
          SELECT json_group_array(p.project_id ORDER BY p.position)
          FROM fork_space_projects p WHERE p.space_id = s.space_id
        ),
        'defaults', json(s.defaults_json), 'pinnedAt', s.pinned_at,
        'archivedAt', s.archived_at, 'createdAt', s.created_at, 'updatedAt', s.updated_at
      ) AS space
      FROM fork_spaces s
    `;
    const threadRows = yield* sql`
      SELECT thread_id AS "threadId", space_id AS "spaceId" FROM fork_thread_spaces
    `;
    return spacesStateFromSnapshot({
      sequence: 0,
      spaces: yield* decodeSpaces(spaceRows.map((row) => row.space)),
      threadSpaces: yield* decodeThreadSpaces(threadRows),
    });
  });

  const view = yield* Ref.make<SpacesView>({
    state: yield* loadView.pipe(Effect.orDie),
    sequence: yield* store.latestSequence.pipe(Effect.orDie),
  });
  const events = yield* PubSub.unbounded<SpacesStreamItem>();
  const lock = yield* Semaphore.make(1);

  const threadExists = (threadId: ThreadId) =>
    projections.getThreadTitles([threadId]).pipe(
      Effect.map((titles) => Object.hasOwn(titles, threadId)),
      Effect.catch(storageFailure),
    );

  const dispatchLocked = Effect.fnUntraced(function* (command: SpaceCommand) {
    const acceptedAt = yield* DateTime.now;
    const rejection = (reason: SpaceCommandRejectionReason, detail: string) =>
      new SpaceCommandRejectedError({ commandId: command.commandId, reason, detail });
    const commandIdReused = (error: ForkCommandIdConflictError) =>
      Effect.fail(rejection("invalid", `command id already used by ${error.storedCommandType}`));

    // A retry can be rejected where the original was accepted (its space now exists, or its
    // thread was since deleted). Such a retry returns the original result. The store has no
    // receipt read, so this commits nothing and rolls back unless the receipt already exists.
    const rejectUnlessCommitted = (reason: SpaceCommandRejectionReason, detail: string) =>
      store
        .commit({
          commandId: command.commandId,
          commandType: command.type,
          acceptedAt,
          events: [],
          project: () => Effect.fail(new NotCommitted()),
        })
        .pipe(
          Effect.catchTags({
            NotCommitted: () => Effect.fail(rejection(reason, detail)),
            ForkCommandIdConflictError: commandIdReused,
            ForkEventStoreWriteError: storageFailure,
          }),
          Effect.map(({ receipt }): SpaceDispatchResult => ({ sequence: receipt.resultSequence })),
        );

    if (command.type === "thread.space.set" && !(yield* threadExists(command.threadId))) {
      return yield* rejectUnlessCommitted("thread_not_found", command.threadId);
    }

    const current = yield* Ref.get(view);
    const decision = decideSpaceCommand(current.state, command, DateTime.formatIso(acceptedAt));
    if (decision._tag === "rejected") {
      return yield* rejectUnlessCommitted(decision.reason, decision.detail);
    }

    const decoded: Array<{ readonly stored: ForkStoredEvent; readonly event: SpaceEvent }> = [];
    const encoded = yield* Effect.forEach(decision.events, (event) =>
      encodeEvent(event).pipe(
        Effect.map((payload) => ({
          streamId: streamIdOf(event),
          type: event.type,
          payload,
          occurredAt: acceptedAt,
        })),
      ),
    ).pipe(Effect.catch(storageFailure));
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
          ForkCommandIdConflictError: commandIdReused,
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
      yield* PubSub.publishAll(events, items);
    }
    return { sequence: result.receipt.resultSequence } satisfies SpaceDispatchResult;
  });

  const dispatch = Effect.fn("SpaceService.dispatch")(function* (command: SpaceCommand) {
    yield* Effect.annotateCurrentSpan({ "fork.command.type": command.type });
    // Uninterruptible: memory must follow a commit that went through.
    return yield* lock.withPermits(1)(Effect.uninterruptible(dispatchLocked(command)));
  });

  return SpaceService.of({ dispatch, ...makeSpaceReads(view, events) });
});

/** Persisted SpaceService: events in fork_events, current state in the fork_spaces projections. */
export const layer = Layer.effect(SpaceService, make);
