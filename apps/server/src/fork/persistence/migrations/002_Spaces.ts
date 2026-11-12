import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Projections of space events. fork_events stays the record: SpaceService truncates and
 * re-projects these tables from the replayed events at every startup.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_spaces (
      space_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      brief TEXT NOT NULL,
      icon_json TEXT CHECK (icon_json IS NULL OR json_valid(icon_json)),
      defaults_json TEXT NOT NULL CHECK (json_valid(defaults_json)),
      pinned_at TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_space_projects (
      space_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (space_id, project_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS fork_space_projects_project_idx
    ON fork_space_projects (project_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_thread_spaces (
      thread_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS fork_thread_spaces_space_idx ON fork_thread_spaces (space_id)
  `;
});
