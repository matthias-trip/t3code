import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import * as ForkLayer from "../ForkLayer.ts";
import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { forkMigrationManifest, runForkMigrations } from "./ForkMigrations.ts";

// Upstream persistence runs upstream migrations; ForkLayer runs on top, as in server.ts.
const layerFreshDatabase = ForkLayer.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const upstreamHead = Math.max(...migrationManifest.map(([id]) => id));

const history = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id
    `;
    return rows.map((row) => [row.migration_id, row.name] as const);
  });

const schemaRowId = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly rowid: number }>`
      SELECT rowid FROM sqlite_schema WHERE name = ${name}
    `;
    return rows[0]?.rowid;
  });

describe("ForkMigrations", () => {
  it.effect("runs after upstream migrations and records only in fork_migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      assert.deepStrictEqual(yield* history("effect_sql_migrations"), migrationManifest);
      assert.deepStrictEqual(yield* history("fork_migrations"), forkMigrationManifest);

      // sqlite_schema rowids grow with creation order: every upstream object came first.
      const [upstream] = yield* sql<{ readonly latestUpstream: number }>`
        SELECT MAX(rowid) AS "latestUpstream" FROM sqlite_schema
        WHERE instr(name, 'fork_') = 0
      `;
      const forkMigrationsTable = yield* schemaRowId("fork_migrations");
      assert.isDefined(forkMigrationsTable);
      assert.isAbove(forkMigrationsTable!, upstream!.latestUpstream);
      assert.isDefined(yield* schemaRowId("fork_events"));
      assert.isDefined(yield* schemaRowId("fork_command_receipts"));

      // Rerunning both tracks is a no-op.
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* runForkMigrations(), []);
    }).pipe(Effect.provide(layerFreshDatabase)),
  );

  it.effect("leaves a later upstream migration runnable after fork migrations ran", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const laterId = upstreamHead + 1;
      // Upstream's migrator, as Migrations.ts builds it, with the next release's migration added.
      const upstreamNextRelease = Migrator.make({});
      const executed = yield* upstreamNextRelease({
        loader: Migrator.fromRecord({
          ...Object.fromEntries(
            migrationManifest.map(([id, name]) => [`${id}_${name}`, Effect.void]),
          ),
          [`${laterId}_SimulatedUpstreamRelease`]: Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TABLE simulated_upstream_release (id INTEGER PRIMARY KEY)`;
          }),
        }),
      });

      assert.deepStrictEqual(executed, [[laterId, "SimulatedUpstreamRelease"]]);
      assert.isDefined(yield* schemaRowId("simulated_upstream_release"));
      assert.deepStrictEqual(yield* history("effect_sql_migrations"), [
        ...migrationManifest,
        [laterId, "SimulatedUpstreamRelease"],
      ]);
      // The fork track is untouched and stays current.
      assert.deepStrictEqual(yield* history("fork_migrations"), forkMigrationManifest);
      assert.deepStrictEqual(yield* runForkMigrations(), []);
      // Upstream's V2 guard still passes: fork rows never reach its table.
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM effect_sql_migrations WHERE name = 'ForkEvents'
      `;
      assert.strictEqual(rows[0]?.count, 0);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(layerFreshDatabase)),
  );
});
