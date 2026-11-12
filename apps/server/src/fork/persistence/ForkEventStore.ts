import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

export class ForkEventStoreWriteError extends Schema.TaggedError<ForkEventStoreWriteError>()(
  "ForkEventStoreWriteError",
  {
    commandId: Schema.String,
    eventCount: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to commit fork command ${this.commandId} with ${this.eventCount} event(s).`;
  }
}

/** A command id was reused for a different command type; the stored receipt is not this command's. */
export class ForkCommandIdConflictError extends Schema.TaggedError<ForkCommandIdConflictError>()(
  "ForkCommandIdConflictError",
  {
    commandId: Schema.String,
    storedCommandType: Schema.String,
    commandType: Schema.String,
  },
) {
  override get message(): string {
    return `Fork command id ${this.commandId} was already used by ${this.storedCommandType}, not ${this.commandType}.`;
  }
}

export class ForkEventStoreReadError extends Schema.TaggedError<ForkEventStoreReadError>()(
  "ForkEventStoreReadError",
  {
    afterSequence: Schema.optional(Schema.Number),
    commandId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    if (this.commandId !== undefined) {
      return `Failed to read the receipt of fork command ${this.commandId}.`;
    }
    return this.afterSequence === undefined
      ? "Failed to read fork events."
      : `Failed to read fork events after sequence ${this.afterSequence}.`;
  }
}

export const ForkStoredEvent = Schema.Struct({
  sequence: Schema.Number,
  streamId: Schema.String,
  streamVersion: Schema.Number,
  type: Schema.String,
  payload: Schema.Unknown,
  commandId: Schema.NullOr(Schema.String),
  occurredAt: Schema.DateTimeUtc,
});
export type ForkStoredEvent = typeof ForkStoredEvent.Type;

const ForkCommandReceipt = Schema.Struct({
  commandId: Schema.String,
  commandType: Schema.String,
  acceptedAt: Schema.DateTimeUtc,
  /** Sequence of the command's last event, or the latest sequence when it appended none. */
  resultSequence: Schema.Number,
});
export type ForkCommandReceipt = typeof ForkCommandReceipt.Type;

export interface ForkEventInput {
  readonly streamId: string;
  readonly type: string;
  /** Must be JSON-serializable; stored and returned as its JSON round-trip. */
  readonly payload: unknown;
  readonly occurredAt: DateTime.Utc;
}

export interface ForkCommitInput<E, R> {
  readonly commandId: string;
  readonly commandType: string;
  readonly acceptedAt: DateTime.Utc;
  readonly events: ReadonlyArray<ForkEventInput>;
  /** Projection writes, run in the commit's transaction after the events are appended. */
  readonly project?: (events: ReadonlyArray<ForkStoredEvent>) => Effect.Effect<void, E, R>;
}

export interface ForkCommitResult {
  readonly receipt: ForkCommandReceipt;
  /** Empty when the command id was already committed. */
  readonly events: ReadonlyArray<ForkStoredEvent>;
  /** False when the command id was already committed; nothing was appended or projected. */
  readonly committed: boolean;
}

export class ForkEventStore extends Context.Service<
  ForkEventStore,
  {
    /**
     * Appends events, runs `project`, and records the receipt in one transaction. A retried id
     * returns its receipt without re-running; reused for another command type it fails as
     * ForkCommandIdConflictError. SqlErrors become ForkEventStoreWriteError; other `project`
     * errors pass through. Any failure rolls everything back.
     */
    readonly commit: <E = never, R = never>(
      input: ForkCommitInput<E, R>,
    ) => Effect.Effect<
      ForkCommitResult,
      ForkEventStoreWriteError | ForkCommandIdConflictError | Exclude<E, SqlError.SqlError>,
      Exclude<R, SqlClient.SqlClient>
    >;
    /** Events with sequence greater than `afterSequence`, oldest first. */
    readonly readAfter: (input: {
      readonly afterSequence: number;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<ForkStoredEvent>, ForkEventStoreReadError>;
    readonly latestSequence: Effect.Effect<number, ForkEventStoreReadError>;
    /** The receipt of a committed command id, if any. */
    readonly receipt: (
      commandId: string,
    ) => Effect.Effect<Option.Option<ForkCommandReceipt>, ForkEventStoreReadError>;
  }
>()("t3/fork/persistence/ForkEventStore") {}

const DEFAULT_READ_LIMIT = 500;

const PayloadJson = Schema.fromJsonString(Schema.Unknown);
const ForkEventRow = ForkStoredEvent.mapFields((fields) => ({
  ...fields,
  payload: PayloadJson,
  occurredAt: Schema.DateTimeUtcFromString,
}));
const decodeEventRows = Schema.decodeUnknownEffect(Schema.Array(ForkEventRow));
const decodeReceiptRow = Schema.decodeUnknownEffect(
  ForkCommandReceipt.mapFields((fields) => ({
    ...fields,
    acceptedAt: Schema.DateTimeUtcFromString,
  })),
);
const encodePayload = Schema.encodeEffect(PayloadJson);
const decodePayload = Schema.decodeEffect(PayloadJson);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectLatestSequence = sql<{ readonly sequence: number }>`
    SELECT COALESCE(MAX(sequence), 0) AS sequence FROM fork_events
  `.pipe(Effect.map((rows) => rows[0]?.sequence ?? 0));

  const selectReceipt = (commandId: string) => sql`
    SELECT command_id AS "commandId", command_type AS "commandType",
      accepted_at AS "acceptedAt", result_sequence AS "resultSequence"
    FROM fork_command_receipts WHERE command_id = ${commandId}
  `;

  // Runs inside commit's span and transaction; no span of its own. Store-owned SQL and schema
  // failures become ForkEventStoreWriteError where they happen, so `project`'s own errors (even
  // a SchemaError) reach the caller unchanged.
  const commitInTransaction = Effect.fnUntraced(function* <E, R>(input: ForkCommitInput<E, R>) {
    const writeError = (cause: unknown) =>
      new ForkEventStoreWriteError({
        commandId: input.commandId,
        eventCount: input.events.length,
        cause,
      });
    const own = <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) =>
      effect.pipe(Effect.mapError(writeError));
    const acceptedAt = DateTime.formatIso(input.acceptedAt);
    // Reserve the receipt first, like upstream's EventSink: a retried id stops here.
    const reserved = yield* own(sql<{ readonly command_id: string }>`
        INSERT INTO fork_command_receipts (command_id, command_type, accepted_at, result_sequence)
        VALUES (${input.commandId}, ${input.commandType}, ${acceptedAt}, 0)
        ON CONFLICT (command_id) DO NOTHING
        RETURNING command_id
      `);
    if (reserved.length === 0) {
      const rows = yield* own(selectReceipt(input.commandId));
      const receipt = yield* own(decodeReceiptRow(rows[0]));
      if (receipt.commandType !== input.commandType) {
        return yield* new ForkCommandIdConflictError({
          commandId: input.commandId,
          storedCommandType: receipt.commandType,
          commandType: input.commandType,
        });
      }
      return { receipt, events: [], committed: false } satisfies ForkCommitResult;
    }

    const versions = new Map<string, number>();
    const stored: Array<ForkStoredEvent> = [];
    for (const event of input.events) {
      let version = versions.get(event.streamId);
      if (version === undefined) {
        const rows = yield* own(sql<{ readonly version: number }>`
            SELECT COALESCE(MAX(stream_version), 0) AS version
            FROM fork_events WHERE stream_id = ${event.streamId}
          `);
        version = rows[0]?.version ?? 0;
      }
      version += 1;
      versions.set(event.streamId, version);
      const payloadJson = yield* own(encodePayload(event.payload));
      const [row] = yield* own(sql<{ readonly sequence: number }>`
          INSERT INTO fork_events (
            stream_id, stream_version, event_type, payload_json, command_id, occurred_at
          ) VALUES (
            ${event.streamId}, ${version}, ${event.type}, ${payloadJson}, ${input.commandId},
            ${DateTime.formatIso(event.occurredAt)}
          )
          RETURNING sequence
        `);
      stored.push({
        sequence: row!.sequence,
        streamId: event.streamId,
        streamVersion: version,
        type: event.type,
        // The JSON round-trip, so live projections see exactly what readAfter replays.
        payload: yield* own(decodePayload(payloadJson)),
        commandId: input.commandId,
        occurredAt: event.occurredAt,
      });
    }

    if (input.project !== undefined) {
      yield* input.project(stored).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchIf(SqlError.isSqlError, (cause) => Effect.fail(writeError(cause))),
      );
    }

    const resultSequence = stored.at(-1)?.sequence ?? (yield* own(selectLatestSequence));
    yield* own(sql`
        UPDATE fork_command_receipts SET result_sequence = ${resultSequence}
        WHERE command_id = ${input.commandId}
      `);
    const receipt: ForkCommandReceipt = {
      commandId: input.commandId,
      commandType: input.commandType,
      acceptedAt: input.acceptedAt,
      resultSequence,
    };
    return { receipt, events: stored, committed: true } satisfies ForkCommitResult;
  });

  const commit = Effect.fn("ForkEventStore.commit")(function* <E, R>(input: ForkCommitInput<E, R>) {
    yield* Effect.annotateCurrentSpan({
      "fork.command.type": input.commandType,
      "fork.command.event_count": input.events.length,
    });
    // Only BEGIN / COMMIT / ROLLBACK can still fail with a raw SqlError here.
    return yield* sql.withTransaction(commitInTransaction(input)).pipe(
      Effect.catchIf(SqlError.isSqlError, (cause) =>
        Effect.fail(
          new ForkEventStoreWriteError({
            commandId: input.commandId,
            eventCount: input.events.length,
            cause,
          }),
        ),
      ),
    );
  });

  const readAfter = Effect.fn("ForkEventStore.readAfter")(function* (input: {
    readonly afterSequence: number;
    readonly limit?: number;
  }) {
    const limit = input.limit ?? DEFAULT_READ_LIMIT;
    return yield* sql`
      SELECT sequence, stream_id AS "streamId", stream_version AS "streamVersion",
        event_type AS "type", payload_json AS "payload", command_id AS "commandId",
        occurred_at AS "occurredAt"
      FROM fork_events
      WHERE sequence > ${input.afterSequence}
      ORDER BY sequence
      LIMIT ${limit}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.flatMap(decodeEventRows),
      Effect.mapError(
        (cause) => new ForkEventStoreReadError({ afterSequence: input.afterSequence, cause }),
      ),
    );
  });

  const latestSequence = selectLatestSequence.pipe(
    NodeSqliteClient.readOnly,
    Effect.mapError((cause) => new ForkEventStoreReadError({ cause })),
    Effect.withSpan("ForkEventStore.latestSequence"),
  );

  const receipt = Effect.fn("ForkEventStore.receipt")(function* (commandId: string) {
    return yield* selectReceipt(commandId).pipe(
      NodeSqliteClient.readOnly,
      Effect.flatMap((rows) =>
        rows.length === 0
          ? Effect.succeed(Option.none<ForkCommandReceipt>())
          : decodeReceiptRow(rows[0]).pipe(Effect.asSome),
      ),
      Effect.mapError((cause) => new ForkEventStoreReadError({ commandId, cause })),
    );
  });

  return ForkEventStore.of({ commit, readAfter, latestSequence, receipt });
});

export const layer = Layer.effect(ForkEventStore, make);
