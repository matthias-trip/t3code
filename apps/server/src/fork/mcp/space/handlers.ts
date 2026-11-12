import {
  CommandId,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import {
  type Space,
  type SpaceCommandRejectedError,
  SpaceId,
  type SpaceServiceError,
} from "@t3tools/fork-spaces/contracts/space";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { assertNotLinked } from "../../../mcp/linkOrigin.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { readCaller, unavailable } from "../../../mcp/threadAccess.ts";
import * as SpaceService from "../../spaces/SpaceService.ts";
import { SpaceToolkit } from "./tools.ts";

// Not in upstream's McpCapability list yet; the orchestrator adds it with the toolkit seam.
const SPACES_CAPABILITY = "spaces";

const requireSpaces = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const granted: ReadonlySet<string> = scope.capabilities;
  if (granted.has(SPACES_CAPABILITY)) return scope;
  return yield* new McpCapabilityUnavailableError({
    capability: SPACES_CAPABILITY,
    environmentId: scope.environmentId,
    ...(scope.thread === undefined
      ? {}
      : {
          threadId: scope.thread.threadId,
          providerSessionId: scope.thread.providerSessionId,
          providerInstanceId: scope.thread.providerInstanceId,
        }),
  });
});

/** Spaces belong to this environment; a linked environment changes only its own work here. */
const requireLocalWriter = requireSpaces.pipe(
  Effect.tap(() =>
    readCaller().pipe(
      Effect.flatMap((caller) => assertNotLinked(caller, "change this environment's spaces")),
    ),
  ),
);

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const spaceNotFound = (spaceId: string) =>
  invalid(`Space ${spaceId} was not found. Find spaces with \`space_list\`.`);

const rejected = (error: SpaceCommandRejectedError | SpaceServiceError) => {
  if (error._tag === "SpaceServiceError") return unavailable();
  switch (error.reason) {
    case "space_not_found":
      return spaceNotFound(error.detail);
    case "space_archived":
      return invalid(`Space ${error.detail} is archived.`);
    case "thread_not_found":
      return new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: `Thread ${error.detail} was not found.`,
      });
    case "space_exists":
      return invalid(`Space ${error.detail} already exists.`);
    default:
      return invalid(`The space change was rejected: ${error.detail}`);
  }
};

const summary = (space: Space) => ({
  spaceId: space.id,
  title: space.title,
  pinned: space.pinnedAt !== null,
  archived: space.archivedAt !== null,
});

const detail = (space: Space) => ({
  ...summary(space),
  brief: space.brief,
  projectIds: space.projectIds,
});

/** The retry key: the caller's, so a retried call repeats its command, or a fresh one. */
const requestKey = Effect.fn("SpaceToolkit.requestKey")(function* (
  clientRequestId: string | undefined,
) {
  if (clientRequestId !== undefined) return clientRequestId;
  const random = yield* SecureRandom.SecureRandom;
  return yield* random.uuidV4();
});

/** Like upstream's MCP command ids: per request namespace, so one caller's key never collides. */
const stableId = (
  prefix: string,
  scope: McpInvocationContext.McpInvocationScope,
  parts: ReadonlyArray<string>,
) =>
  [
    prefix,
    "mcp",
    encodeURIComponent(scope.requestNamespace),
    ...parts.map(encodeURIComponent),
  ].join(":");

const dispatch = Effect.fn("SpaceToolkit.dispatch")(function* (
  build: (commandId: CommandId) => Parameters<SpaceService.SpaceService["Service"]["dispatch"]>[0],
  operation: string,
  target: string,
  clientRequestId: string | undefined,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const spaces = yield* SpaceService.SpaceService;
  const key = yield* requestKey(clientRequestId);
  const commandId = CommandId.make(stableId("command", scope, [operation, target, key]));
  yield* spaces.dispatch(build(commandId)).pipe(Effect.mapError(rejected));
});

export const layer = McpToolAccess.toLayer(SpaceToolkit, {
  space_list: McpToolAccess.reads(({ includeArchived }) =>
    Effect.gen(function* () {
      yield* requireSpaces;
      const spaces = yield* SpaceService.SpaceService;
      const listed = yield* spaces
        .listSpaces({ includeArchived: includeArchived === true })
        .pipe(Effect.mapError(rejected));
      return { spaces: listed.map(summary) };
    }),
  ),
  space_read: McpToolAccess.reads(({ spaceId }) =>
    Effect.gen(function* () {
      const scope = yield* requireSpaces;
      const spaces = yield* SpaceService.SpaceService;
      if (spaceId !== undefined) {
        const space = yield* spaces.getSpace(spaceId).pipe(Effect.mapError(rejected));
        if (Option.isNone(space)) return yield* spaceNotFound(spaceId);
        return { space: detail(space.value) };
      }
      if (scope.thread === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "target_required",
          message: "Pass spaceId: this MCP client is not running inside a T3 thread.",
        });
      const space = yield* spaces
        .spaceForThread(scope.thread.threadId)
        .pipe(Effect.mapError(rejected));
      return { space: Option.isNone(space) ? null : detail(space.value) };
    }),
  ),
  space_create: McpToolAccess.writes(
    ({ clientRequestId, ...fields }) =>
      Effect.gen(function* () {
        const scope = yield* requireLocalWriter;
        const key = yield* requestKey(clientRequestId);
        // Derived from the retry key, so a retry finds the space it already made.
        const spaceId = SpaceId.make(stableId("space", scope, [key]));
        yield* dispatch(
          (commandId) => ({ type: "space.create", commandId, spaceId, ...fields }),
          "space-create",
          spaceId,
          key,
        );
        return { spaceId };
      }),
    { linkedCallers: "allowed" },
  ),
  space_update: McpToolAccess.writes(
    ({ clientRequestId, spaceId, ...fields }) =>
      Effect.gen(function* () {
        yield* requireLocalWriter;
        yield* dispatch(
          (commandId) => ({ type: "space.update", commandId, spaceId, ...fields }),
          "space-update",
          spaceId,
          clientRequestId,
        );
        return { spaceId };
      }),
    { linkedCallers: "allowed" },
  ),
  space_move_thread: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    ({ clientRequestId, spaceId, ...input }) =>
      Effect.gen(function* () {
        const scope = yield* requireLocalWriter;
        const threadId: ThreadId | undefined = input.threadId ?? scope.thread?.threadId;
        if (threadId === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass threadId: this MCP client is not running inside a T3 thread.",
          });
        yield* dispatch(
          (commandId) => ({ type: "thread.space.set", commandId, threadId, spaceId }),
          "space-move-thread",
          threadId,
          clientRequestId,
        );
        return { threadId, spaceId };
      }),
  ),
});
