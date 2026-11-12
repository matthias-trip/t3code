import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      stream_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      command_id TEXT,
      occurred_at TEXT NOT NULL,
      UNIQUE (stream_id, stream_version)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_command_receipts (
      command_id TEXT PRIMARY KEY,
      command_type TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      result_sequence INTEGER NOT NULL
    )
  `;
});
