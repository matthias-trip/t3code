import {
  CommandId,
  ForwardCompatibleUnion,
  IsoDateTime,
  ModelSelection,
  NonNegativeInt,
  ProjectIconOverride,
  ProjectId,
  ThreadEnvMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * A space groups the threads, projects and (later) sources of one piece of work. It is
 * environment-local, like a project. A thread is in at most one space; spaces and projects are
 * many-to-many.
 */
export const SpaceId = TrimmedNonEmptyString.pipe(Schema.brand("SpaceId"));
export type SpaceId = typeof SpaceId.Type;

export const SpaceTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(120));

/** Markdown shown to people and injected as context for agents in the space's threads. */
export const SpaceBrief = Schema.String.check(Schema.isMaxLength(20_000));

export const SpaceDefaults = Schema.Struct({
  modelSelection: Schema.optional(ModelSelection),
  threadEnvMode: Schema.optional(ThreadEnvMode),
});
export type SpaceDefaults = typeof SpaceDefaults.Type;

export const Space = Schema.Struct({
  id: SpaceId,
  title: SpaceTitle,
  brief: SpaceBrief,
  icon: Schema.NullOr(ProjectIconOverride),
  /** Projects the work touches; the first is the default for new threads. No duplicates. */
  projectIds: Schema.Array(ProjectId),
  defaults: SpaceDefaults,
  pinnedAt: Schema.NullOr(IsoDateTime),
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Space = typeof Space.Type;

export const ThreadSpace = Schema.Struct({ threadId: ThreadId, spaceId: SpaceId });
export type ThreadSpace = typeof ThreadSpace.Type;

// Commands. `commandId` makes a retry idempotent (ForkEventStore receipts).

export const SpaceCreateCommand = Schema.Struct({
  type: Schema.Literal("space.create"),
  commandId: CommandId,
  spaceId: SpaceId,
  title: SpaceTitle,
  brief: Schema.optional(SpaceBrief),
  icon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  projectIds: Schema.optional(Schema.Array(ProjectId)),
  defaults: Schema.optional(SpaceDefaults),
});

/** Omitted fields stay as they are. `icon: null` clears the icon; `pinned` pins or unpins. */
export const SpaceUpdateCommand = Schema.Struct({
  type: Schema.Literal("space.update"),
  commandId: CommandId,
  spaceId: SpaceId,
  title: Schema.optional(SpaceTitle),
  brief: Schema.optional(SpaceBrief),
  icon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  projectIds: Schema.optional(Schema.Array(ProjectId)),
  defaults: Schema.optional(SpaceDefaults),
  pinned: Schema.optional(Schema.Boolean),
});

export const SpaceArchiveCommand = Schema.Struct({
  type: Schema.Literal("space.archive"),
  commandId: CommandId,
  spaceId: SpaceId,
});

export const SpaceUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("space.unarchive"),
  commandId: CommandId,
  spaceId: SpaceId,
});

/** Only an archived space can be deleted. Its threads leave the space; the threads remain. */
export const SpaceDeleteCommand = Schema.Struct({
  type: Schema.Literal("space.delete"),
  commandId: CommandId,
  spaceId: SpaceId,
});

/** `spaceId: null` takes the thread out of its space. The thread must exist (checked by the service). */
export const ThreadSpaceSetCommand = Schema.Struct({
  type: Schema.Literal("thread.space.set"),
  commandId: CommandId,
  threadId: ThreadId,
  spaceId: Schema.NullOr(SpaceId),
});

export const SpaceCommand = Schema.Union([
  SpaceCreateCommand,
  SpaceUpdateCommand,
  SpaceArchiveCommand,
  SpaceUnarchiveCommand,
  SpaceDeleteCommand,
  ThreadSpaceSetCommand,
]);
export type SpaceCommand = typeof SpaceCommand.Type;

// Events, as stored in fork_events (stream id = space id, or thread id for thread.space-updated).

export const SpaceCreatedEvent = Schema.Struct({
  type: Schema.Literal("space.created"),
  space: Space,
});

/** Carries the whole space after the change (update, pin, archive, unarchive). */
export const SpaceUpdatedEvent = Schema.Struct({
  type: Schema.Literal("space.updated"),
  space: Space,
});

/** Also removes every thread from the space; no per-thread events are emitted for that. */
export const SpaceDeletedEvent = Schema.Struct({
  type: Schema.Literal("space.deleted"),
  spaceId: SpaceId,
});

export const ThreadSpaceUpdatedEvent = Schema.Struct({
  type: Schema.Literal("thread.space-updated"),
  threadId: ThreadId,
  spaceId: Schema.NullOr(SpaceId),
  previousSpaceId: Schema.NullOr(SpaceId),
});

const spaceEventMembers = [
  SpaceCreatedEvent,
  SpaceUpdatedEvent,
  SpaceDeletedEvent,
  ThreadSpaceUpdatedEvent,
] as const;

export const SpaceEvent = Schema.Union(spaceEventMembers);
export type SpaceEvent = typeof SpaceEvent.Type;

/** What clients decode: an event type a newer server adds arrives as an unknown member and is skipped. */
export const ReceivedSpaceEvent = ForwardCompatibleUnion(spaceEventMembers, "type");
export type ReceivedSpaceEvent = typeof ReceivedSpaceEvent.Type;

export const SpaceCommandRejectionReason = Schema.Literals([
  "space_exists",
  "space_not_found",
  "space_archived",
  "space_not_archived",
  "thread_not_found",
  "invalid",
]);
export type SpaceCommandRejectionReason = typeof SpaceCommandRejectionReason.Type;

export class SpaceCommandRejectedError extends Schema.TaggedError<SpaceCommandRejectedError>()(
  "SpaceCommandRejectedError",
  {
    commandId: CommandId,
    reason: SpaceCommandRejectionReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Space command ${this.commandId} rejected (${this.reason}): ${this.detail}`;
  }
}

/** A failure the client can't act on (storage), reported without internals. */
export class SpaceServiceError extends Schema.TaggedError<SpaceServiceError>()(
  "SpaceServiceError",
  { detail: Schema.String },
) {}

/** Everything clients need to render spaces, as of `sequence` in fork_events. */
export const SpacesSnapshot = Schema.Struct({
  sequence: NonNegativeInt,
  spaces: Schema.Array(Space),
  threadSpaces: Schema.Array(ThreadSpace),
});
export type SpacesSnapshot = typeof SpacesSnapshot.Type;

/**
 * `fork.spaces.subscribe` first sends a snapshot (always, so a reconnect needs no cursor
 * bookkeeping), then every space event after it, in order.
 */
export const SpacesStreamItem = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: SpacesSnapshot }),
  Schema.Struct({
    type: Schema.Literal("event"),
    sequence: NonNegativeInt,
    event: ReceivedSpaceEvent,
  }),
]);
export type SpacesStreamItem = typeof SpacesStreamItem.Type;

export const SpaceDispatchResult = Schema.Struct({
  /** fork_events sequence after the command; a client is up to date once it has seen it. */
  sequence: NonNegativeInt,
});
export type SpaceDispatchResult = typeof SpaceDispatchResult.Type;
