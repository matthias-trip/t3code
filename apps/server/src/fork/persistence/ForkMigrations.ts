import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";

import Migration0001 from "./migrations/001_ForkEvents.ts";
import Migration0002 from "./migrations/002_Spaces.ts";

// Fork-owned schema runs on its own migrator and table. Upstream's migrator skips every id up to
// the highest one recorded in effect_sql_migrations, so a fork row there would break the next
// upstream release. Ids here start at 1 and only create or alter fork_* tables.
const FORK_MIGRATIONS_TABLE = "fork_migrations";

const migrationEntries = [
  [1, "ForkEvents", Migration0001],
  [2, "Spaces", Migration0002],
] as const;

export const forkMigrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

const loader = Migrator.fromRecord(
  Object.fromEntries(migrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration])),
);

const run = Migrator.make({});

/** Run after upstream's runMigrations; ForkLayer gets its SqlClient from the migrated database. */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const executed = yield* run({ loader, table: FORK_MIGRATIONS_TABLE });
  const migrations = executed.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Fork database schema is current")
    : Effect.log("Fork migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executed;
});
