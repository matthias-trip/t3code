import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import {
  SpaceId,
  type SpaceCommand,
  type SpaceEvent,
  type SpacesSnapshot,
  type SpacesStreamItem,
} from "@t3tools/fork-spaces/contracts/space";
import { fixtureCommandId } from "@t3tools/fork-spaces/shared/spaceFixtures";
import {
  applySpaceEvent,
  spacesSnapshotFromState,
  spacesStateFromSnapshot,
} from "@t3tools/fork-spaces/shared/spaces";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ForkLayer from "../ForkLayer.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { SpaceService } from "./SpaceService.ts";

const layerTest = ForkLayer.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const spaceId = SpaceId.make("space:retry");
const otherSpaceId = SpaceId.make("space:other");
const threadId = ThreadId.make("thread:live");
const projects = {
  a: ProjectId.make("project:a"),
  b: ProjectId.make("project:b"),
  c: ProjectId.make("project:c"),
};

/** A thread row in upstream's projection, which SpaceService checks before moving a thread. */
const seedThread = (id: ThreadId, options?: { readonly deleted?: boolean }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = "2026-11-12T10:00:00.000Z";
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at, payload_json
      ) VALUES (
        ${id}, ${projects.a}, ${id}, 'codex', 'full-access', 'default', ${at}, ${at},
        ${options?.deleted === true ? at : null}, '{}'
      )
    `;
  });

const deleteThread = (id: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET deleted_at = '2026-11-12T11:00:00.000Z' WHERE thread_id = ${id}
    `;
  });

const dispatch = (command: SpaceCommand) => SpaceService.use((spaces) => spaces.dispatch(command));

const create = (name: string, id: SpaceId = spaceId) =>
  dispatch({
    type: "space.create",
    commandId: fixtureCommandId(name),
    spaceId: id,
    title: `Space ${name}`,
  });

/** The rejection reason, or the error tag when the command failed otherwise. */
const rejectionOf = (command: SpaceCommand) =>
  dispatch(command).pipe(
    Effect.flip,
    Effect.map((error) => (error._tag === "SpaceCommandRejectedError" ? error.reason : error._tag)),
  );

const spaceRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly space_id: string;
    readonly title: string;
    readonly icon_json: string | null;
    readonly defaults_json: string;
    readonly pinned_at: string | null;
    readonly archived_at: string | null;
  }>`
    SELECT space_id, title, icon_json, defaults_json, pinned_at, archived_at
    FROM fork_spaces ORDER BY space_id
  `;
});

const storageError = { _tag: "SpaceServiceError", detail: "Spaces could not be read or saved." };

const projectRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly project_id: string }>`
    SELECT project_id FROM fork_space_projects WHERE space_id = ${spaceId} ORDER BY position
  `;
  return rows.map((row) => row.project_id);
});

const threadRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly thread_id: string; readonly space_id: string }>`
    SELECT thread_id, space_id FROM fork_thread_spaces ORDER BY thread_id
  `;
});

const eventCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM fork_events`;
  return row!.count;
});

const sortedSnapshot = (snapshot: SpacesSnapshot) => ({
  sequence: snapshot.sequence,
  spaces: snapshot.spaces.toSorted((a, b) => a.id.localeCompare(b.id)),
  threadSpaces: snapshot.threadSpaces.toSorted((a, b) => a.threadId.localeCompare(b.threadId)),
});

describe("SpaceService (persisted)", () => {
  it.effect("projects create, update, pin, unpin, archive, unarchive and delete", () =>
    Effect.gen(function* () {
      yield* seedThread(threadId);
      yield* dispatch({
        type: "space.create",
        commandId: fixtureCommandId("create"),
        spaceId,
        title: "Retry",
        icon: { kind: "monogram", text: "RT", color: "indigo" },
        projectIds: [projects.a, projects.b],
        defaults: { threadEnvMode: "worktree" },
      });
      const [created] = yield* spaceRows;
      assert.strictEqual(created?.title, "Retry");
      assert.deepStrictEqual(JSON.parse(created!.icon_json!), {
        kind: "monogram",
        text: "RT",
        color: "indigo",
      });
      assert.deepStrictEqual(JSON.parse(created!.defaults_json), { threadEnvMode: "worktree" });
      assert.deepStrictEqual(yield* projectRows, [projects.a, projects.b]);

      yield* dispatch({
        type: "space.update",
        commandId: fixtureCommandId("update"),
        spaceId,
        title: "Retry v2",
        icon: null,
        projectIds: [projects.c, projects.a],
      });
      const [updated] = yield* spaceRows;
      assert.strictEqual(updated?.title, "Retry v2");
      assert.isNull(updated?.icon_json);
      assert.deepStrictEqual(yield* projectRows, [projects.c, projects.a]);

      yield* dispatch({
        type: "space.update",
        commandId: fixtureCommandId("pin"),
        spaceId,
        pinned: true,
      });
      assert.isNotNull((yield* spaceRows)[0]?.pinned_at);
      yield* dispatch({
        type: "space.update",
        commandId: fixtureCommandId("unpin"),
        spaceId,
        pinned: false,
      });
      assert.isNull((yield* spaceRows)[0]?.pinned_at);

      yield* dispatch({
        type: "thread.space.set",
        commandId: fixtureCommandId("move"),
        threadId,
        spaceId,
      });
      yield* dispatch({ type: "space.archive", commandId: fixtureCommandId("archive"), spaceId });
      assert.isNotNull((yield* spaceRows)[0]?.archived_at);
      yield* dispatch({
        type: "space.unarchive",
        commandId: fixtureCommandId("unarchive"),
        spaceId,
      });
      assert.isNull((yield* spaceRows)[0]?.archived_at);

      yield* dispatch({ type: "space.archive", commandId: fixtureCommandId("archive2"), spaceId });
      yield* dispatch({ type: "space.delete", commandId: fixtureCommandId("delete"), spaceId });
      assert.deepStrictEqual(yield* spaceRows, []);
      assert.deepStrictEqual(yield* projectRows, []);
      assert.deepStrictEqual(yield* threadRows, []);
      const spaces = yield* SpaceService;
      assert.isTrue(Option.isNone(yield* spaces.spaceForThread(threadId)));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("moves a thread in and out and rejects threads upstream does not have", () =>
    Effect.gen(function* () {
      const spaces = yield* SpaceService;
      yield* seedThread(threadId);
      const deletedThreadId = ThreadId.make("thread:deleted");
      yield* seedThread(deletedThreadId, { deleted: true });
      yield* create("a");

      yield* dispatch({
        type: "thread.space.set",
        commandId: fixtureCommandId("in"),
        threadId,
        spaceId,
      });
      assert.deepStrictEqual(yield* threadRows, [{ thread_id: threadId, space_id: spaceId }]);
      assert.strictEqual(Option.getOrThrow(yield* spaces.spaceForThread(threadId)).id, spaceId);

      yield* dispatch({
        type: "thread.space.set",
        commandId: fixtureCommandId("out"),
        threadId,
        spaceId: null,
      });
      assert.deepStrictEqual(yield* threadRows, []);

      for (const missing of [ThreadId.make("thread:missing"), deletedThreadId]) {
        const reason = yield* rejectionOf({
          type: "thread.space.set",
          commandId: fixtureCommandId(`missing:${missing}`),
          threadId: missing,
          spaceId,
        });
        assert.strictEqual(reason, "thread_not_found");
      }
      assert.deepStrictEqual(yield* threadRows, []);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("returns the first result for a retried command id", () =>
    Effect.gen(function* () {
      const first = yield* create("a");
      // The decider alone would reject this retry: the space exists now.
      assert.deepStrictEqual(yield* create("a"), first);

      const rename = {
        type: "space.update",
        commandId: fixtureCommandId("rename"),
        spaceId,
        title: "Renamed",
      } as const;
      const renamed = yield* dispatch(rename);
      yield* dispatch({ ...rename, commandId: fixtureCommandId("rename2"), title: "Again" });
      // A late retry of the first rename must not undo the second one.
      assert.deepStrictEqual(yield* dispatch(rename), renamed);
      const spaces = yield* SpaceService;
      assert.strictEqual(Option.getOrThrow(yield* spaces.getSpace(spaceId)).title, "Again");
      assert.strictEqual(yield* eventCount, 3);

      const reused = yield* rejectionOf({
        type: "space.archive",
        commandId: fixtureCommandId("a"),
        spaceId,
      });
      assert.strictEqual(reused, "invalid");

      // A rejected command leaves no receipt, so it can succeed once the state allows it.
      const early = {
        type: "space.delete",
        commandId: fixtureCommandId("delete"),
        spaceId,
      } as const;
      assert.strictEqual(yield* rejectionOf(early), "space_not_archived");
      yield* dispatch({ type: "space.archive", commandId: fixtureCommandId("archive"), spaceId });
      yield* dispatch(early);
      assert.isTrue(Option.isNone(yield* spaces.getSpace(spaceId)));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("streams a snapshot, then each later event exactly once, during dispatches", () =>
    Effect.gen(function* () {
      const spaces = yield* SpaceService;
      const before = 5;
      const total = 20;
      const createAt = (index: number) => create(`c${index}`, SpaceId.make(`space:${index}`));
      const range = (from: number, to: number) =>
        Array.from({ length: to - from }, (_, index) => from + index);

      yield* Effect.forEach(range(0, before), createAt);
      const subscribed = yield* Deferred.make<void>();
      const writer = yield* Deferred.await(subscribed).pipe(
        Effect.andThen(Effect.forEach(range(before, total), createAt)),
        Effect.forkChild,
      );

      const positionOf = (item: SpacesStreamItem) =>
        item.type === "snapshot" ? item.snapshot.sequence : item.sequence;
      const items = yield* spaces.subscribe.pipe(
        // The snapshot is read after the subscription opens, so the writer starts after both.
        Stream.tap((item) =>
          item.type === "snapshot" ? Deferred.succeed(subscribed, undefined) : Effect.void,
        ),
        Stream.takeUntil((item) => positionOf(item) === total),
        Stream.runCollect,
      );
      yield* Fiber.join(writer);

      const [head, ...rest] = items;
      assert.strictEqual(head?.type, "snapshot");
      const snapshot = (head as Extract<SpacesStreamItem, { type: "snapshot" }>).snapshot;
      assert.strictEqual(snapshot.sequence, before);
      assert.isAbove(rest.length, 0);
      assert.deepStrictEqual(
        rest.map(positionOf),
        range(before, total).map((index) => index + 1),
      );
      let state = spacesStateFromSnapshot(snapshot);
      for (const item of rest) {
        if (item.type === "event") state = applySpaceEvent(state, item.event as SpaceEvent);
      }
      assert.strictEqual(state.spaces.size, total);
      assert.deepStrictEqual(
        sortedSnapshot(spacesSnapshotFromState(state, total)),
        sortedSnapshot(yield* spaces.snapshot),
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("fails a dispatch whose projection write fails and leaves state unchanged", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const spaces = yield* SpaceService;
      yield* create("a");
      const before = yield* spaces.snapshot;

      yield* sql`DROP TABLE fork_space_projects`;
      const error = yield* create("b", otherSpaceId).pipe(Effect.flip);
      assert.deepStrictEqual({ _tag: error._tag, detail: error.detail }, storageError);
      assert.deepStrictEqual(yield* spaces.snapshot, before);
      assert.strictEqual(yield* eventCount, 1);

      yield* sql`
        CREATE TABLE fork_space_projects (
          space_id TEXT NOT NULL, project_id TEXT NOT NULL, position INTEGER NOT NULL,
          PRIMARY KEY (space_id, project_id)
        )
      `;
      yield* create("b", otherSpaceId);
      assert.isTrue(Option.isSome(yield* spaces.getSpace(otherSpaceId)));
      assert.strictEqual(yield* eventCount, 2);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("hides deleted threads, still lets them leave their space, and keeps retries", () =>
    Effect.gen(function* () {
      const spaces = yield* SpaceService;
      yield* seedThread(threadId);
      yield* create("a");
      const move = {
        type: "thread.space.set",
        commandId: fixtureCommandId("move"),
        threadId,
        spaceId,
      } as const;
      const moved = yield* dispatch(move);

      yield* deleteThread(threadId);
      assert.deepStrictEqual((yield* spaces.snapshot).threadSpaces, []);
      const [first] = yield* spaces.subscribe.pipe(Stream.take(1), Stream.runCollect);
      assert.deepStrictEqual(
        first?.type === "snapshot" ? first.snapshot.threadSpaces : undefined,
        [],
      );
      // The membership is kept, in case the thread comes back.
      assert.deepStrictEqual(yield* threadRows, [{ thread_id: threadId, space_id: spaceId }]);

      // The thread check rejects the retry now; the receipt still returns the first result.
      assert.deepStrictEqual(yield* dispatch(move), moved);

      yield* dispatch({
        type: "thread.space.set",
        commandId: fixtureCommandId("out"),
        threadId,
        spaceId: null,
      });
      assert.deepStrictEqual(yield* threadRows, []);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("reloads state from the events after a restart", () =>
    Effect.gen(function* () {
      yield* seedThread(threadId);
      const before = yield* Effect.gen(function* () {
        yield* create("a");
        yield* create("b", otherSpaceId);
        yield* dispatch({
          type: "space.update",
          commandId: fixtureCommandId("edit"),
          spaceId,
          brief: "Brief",
          projectIds: [projects.b, projects.a],
          pinned: true,
        });
        yield* dispatch({
          type: "thread.space.set",
          commandId: fixtureCommandId("move"),
          threadId,
          spaceId,
        });
        yield* dispatch({
          type: "space.archive",
          commandId: fixtureCommandId("archive"),
          spaceId: otherSpaceId,
        });
        return yield* SpaceService.use((spaces) => spaces.snapshot);
      }).pipe(Effect.provide(ForkLayer.layer));

      const after = yield* Effect.gen(function* () {
        const spaces = yield* SpaceService;
        const snapshot = yield* spaces.snapshot;
        // Receipts outlive the process: a retry after the restart is still a no-op.
        assert.deepStrictEqual(yield* create("a"), { sequence: 1 });
        return snapshot;
      }).pipe(Effect.provide(ForkLayer.layer));

      assert.strictEqual(before.sequence, 5);
      assert.deepStrictEqual(sortedSnapshot(after), sortedSnapshot(before));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("skips an event that does not decode and re-projects the rest at startup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedThread(threadId);
      const before = yield* Effect.gen(function* () {
        yield* create("a");
        yield* create("b", otherSpaceId);
        yield* dispatch({
          type: "thread.space.set",
          commandId: fixtureCommandId("move"),
          threadId,
          spaceId,
        });
        return yield* SpaceService.use((spaces) => spaces.snapshot);
      }).pipe(Effect.provide(ForkLayer.layer));

      yield* sql`
        INSERT INTO fork_events (
          stream_id, stream_version, event_type, payload_json, command_id, occurred_at
        ) VALUES (
          'space:space:broken', 1, 'space.created',
          '{"type":"space.created","space":{"id":"space:broken"}}', NULL,
          '2026-11-12T10:00:00.000Z'
        )
      `;
      // Projection rows the events do not support, and one they do, missing.
      yield* sql`DELETE FROM fork_spaces WHERE space_id = ${otherSpaceId}`;
      yield* sql`INSERT INTO fork_thread_spaces VALUES ('thread:stale', ${spaceId})`;

      const after = yield* SpaceService.use((spaces) => spaces.snapshot).pipe(
        Effect.provide(ForkLayer.layer),
      );
      assert.deepStrictEqual(sortedSnapshot(after), {
        ...sortedSnapshot(before),
        sequence: before.sequence + 1,
      });
      assert.deepStrictEqual(
        (yield* spaceRows).map((row) => row.space_id),
        [otherSpaceId, spaceId],
      );
      assert.deepStrictEqual(yield* threadRows, [{ thread_id: threadId, space_id: spaceId }]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("starts with spaces unavailable when the events cannot be read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.void.pipe(Effect.provide(ForkLayer.layer));
      yield* sql`DROP TABLE fork_events`;

      const errors = yield* Effect.gen(function* () {
        const spaces = yield* SpaceService;
        return [yield* spaces.snapshot.pipe(Effect.flip), yield* create("a").pipe(Effect.flip)];
      }).pipe(Effect.provide(ForkLayer.layer));
      assert.deepStrictEqual(
        errors.map((error) => error._tag),
        ["SpaceServiceError", "SpaceServiceError"],
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
