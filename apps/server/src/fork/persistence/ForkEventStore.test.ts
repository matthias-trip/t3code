import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ForkLayer from "../ForkLayer.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ForkEventStore from "./ForkEventStore.ts";

const layerTest = ForkLayer.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

class ProjectionRejected extends Schema.TaggedError<ProjectionRejected>()(
  "ProjectionRejected",
  {},
) {}

const occurredAt = DateTime.makeUnsafe("2026-11-12T10:00:00.000Z");

const createProjectionTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE fork_test_projection (stream_id TEXT PRIMARY KEY, version INTEGER)`;
});

const projectVersions = (events: ReadonlyArray<ForkEventStore.ForkStoredEvent>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const event of events) {
      yield* sql`
        INSERT INTO fork_test_projection (stream_id, version)
        VALUES (${event.streamId}, ${event.streamVersion})
        ON CONFLICT (stream_id) DO UPDATE SET version = excluded.version
      `;
    }
  });

const counts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    readonly events: number;
    readonly receipts: number;
    readonly projections: number;
  }>`
    SELECT
      (SELECT COUNT(*) FROM fork_events) AS events,
      (SELECT COUNT(*) FROM fork_command_receipts) AS receipts,
      (SELECT COUNT(*) FROM fork_test_projection) AS projections
  `;
  return row;
});

const spaceCreated = (streamId: string, name: string): ForkEventStore.ForkEventInput => ({
  streamId,
  type: "space.created",
  payload: { name },
  occurredAt,
});

describe("ForkEventStore", () => {
  it.effect("commits events, projection writes, and the receipt together", () =>
    Effect.gen(function* () {
      yield* createProjectionTable;
      const store = yield* ForkEventStore.ForkEventStore;

      const result = yield* store.commit({
        commandId: "command:1",
        commandType: "space.create",
        acceptedAt: occurredAt,
        events: [spaceCreated("space:a", "A"), spaceCreated("space:a", "A2")],
        project: projectVersions,
      });

      assert.isTrue(result.committed);
      assert.deepStrictEqual(
        result.events.map((event) => [event.streamId, event.streamVersion]),
        [
          ["space:a", 1],
          ["space:a", 2],
        ],
      );
      assert.strictEqual(result.receipt.resultSequence, result.events[1]!.sequence);
      assert.deepStrictEqual(yield* counts, { events: 2, receipts: 1, projections: 1 });
      assert.deepStrictEqual(yield* store.readAfter({ afterSequence: 0 }), result.events);
      assert.deepStrictEqual(
        yield* store.readAfter({ afterSequence: result.events[0]!.sequence }),
        [result.events[1]!],
      );
      assert.strictEqual(yield* store.latestSequence, result.receipt.resultSequence);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("leaves no event and no receipt when the projection write fails", () =>
    Effect.gen(function* () {
      yield* createProjectionTable;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ForkEventStore.ForkEventStore;
      const input = {
        commandId: "command:fails",
        commandType: "space.create",
        acceptedAt: occurredAt,
        events: [spaceCreated("space:a", "A")],
      };

      const rejected = yield* Effect.exit(
        store.commit({
          ...input,
          project: (events: ReadonlyArray<ForkEventStore.ForkStoredEvent>) =>
            projectVersions(events).pipe(Effect.andThen(Effect.fail(new ProjectionRejected()))),
        }),
      );
      assert.isTrue(Exit.isFailure(rejected));
      assert.include(String(rejected), "ProjectionRejected");
      assert.deepStrictEqual(yield* counts, { events: 0, receipts: 0, projections: 0 });

      const sqlFailure = yield* Effect.exit(
        store.commit({
          ...input,
          project: () => sql`INSERT INTO fork_missing_projection (id) VALUES (1)`,
        }),
      );
      assert.isTrue(Exit.isFailure(sqlFailure));
      assert.include(String(sqlFailure), "ForkEventStoreWriteError");
      assert.deepStrictEqual(yield* counts, { events: 0, receipts: 0, projections: 0 });

      // The id was never consumed, so a corrected retry commits.
      const retried = yield* store.commit({ ...input, project: projectVersions });
      assert.isTrue(retried.committed);
      assert.deepStrictEqual(yield* counts, { events: 1, receipts: 1, projections: 1 });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("returns the stored receipt for a retried command id without appending", () =>
    Effect.gen(function* () {
      yield* createProjectionTable;
      const store = yield* ForkEventStore.ForkEventStore;
      let projections = 0;
      const input = {
        commandId: "command:retry",
        commandType: "space.create",
        acceptedAt: occurredAt,
        events: [spaceCreated("space:a", "A")],
        project: (events: ReadonlyArray<ForkEventStore.ForkStoredEvent>) =>
          Effect.sync(() => {
            projections += 1;
          }).pipe(Effect.andThen(projectVersions(events))),
      };

      const first = yield* store.commit(input);
      const second = yield* store.commit({
        ...input,
        acceptedAt: DateTime.makeUnsafe("2026-11-12T11:00:00.000Z"),
        events: [spaceCreated("space:a", "A"), spaceCreated("space:b", "B")],
      });

      assert.isTrue(first.committed);
      assert.isFalse(second.committed);
      assert.deepStrictEqual(second.events, []);
      assert.deepStrictEqual(second.receipt, first.receipt);
      assert.strictEqual(projections, 1);
      assert.deepStrictEqual(yield* counts, { events: 1, receipts: 1, projections: 1 });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("records the latest sequence for a command that appends no events", () =>
    Effect.gen(function* () {
      yield* createProjectionTable;
      const store = yield* ForkEventStore.ForkEventStore;
      const first = yield* store.commit({
        commandId: "command:with-event",
        commandType: "space.create",
        acceptedAt: occurredAt,
        events: [spaceCreated("space:a", "A")],
      });
      const empty = yield* store.commit({
        commandId: "command:no-op",
        commandType: "space.update",
        acceptedAt: occurredAt,
        events: [],
      });
      assert.isTrue(empty.committed);
      assert.strictEqual(empty.receipt.resultSequence, first.receipt.resultSequence);
    }).pipe(Effect.provide(layerTest)),
  );
});
