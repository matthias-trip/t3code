// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  type ProjectId,
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
import { assertFullAccess, readCaller, unavailable } from "../../../mcp/threadAccess.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as SpaceService from "../../spaces/SpaceService.ts";
import { MCP_BRIEF_MAX_LENGTH, SPACES_CAPABILITY, SpaceToolkit } from "./tools.ts";

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

/**
 * Spaces belong to this environment, so a fenced linked caller may not change them. The write
 * declarations let linked callers through only so that this refusal names spaces.
 */
const requireLocalWriter = requireSpaces.pipe(
  Effect.tap(() =>
    readCaller().pipe(
      Effect.flatMap((caller) => assertNotLinked(caller, "change this environment's spaces")),
    ),
  ),
);

/** A title or brief is what agents in the space's threads are told, so it needs full access. */
const requireBriefWriter = readCaller().pipe(
  Effect.flatMap((caller) =>
    assertFullAccess(
      caller,
      "Setting a space's title or brief changes what agents in its threads are told. It needs a live full-access/default calling thread or a full-access client.",
    ),
  ),
);

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const checkBrief = (brief: string | undefined) =>
  brief === undefined || brief.length <= MCP_BRIEF_MAX_LENGTH
    ? Effect.void
    : Effect.fail(
        invalid(
          `The brief is ${brief.length} characters; briefs written over MCP are limited to ${MCP_BRIEF_MAX_LENGTH}.`,
        ),
      );

const spaceNotFound = (spaceId: string) =>
  invalid(`Space ${spaceId} was not found. Find spaces with \`space_list\`.`);

const reusedKey = (clientRequestId: string) =>
  invalid(
    `clientRequestId ${clientRequestId} was already used for a different call. Use a new one.`,
  );

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
      // The space id comes from the retry key, so this is a key reused for another call.
      return invalid(
        `Space ${error.detail} already exists: its clientRequestId was used for a different call. Use a new one.`,
      );
    default:
      return invalid(`The space change was rejected: ${error.detail}`);
  }
};

/** Logs what the generic MCP error hides, then maps every space error to an MCP failure. */
const spaceCall = <A, R>(
  operation: string,
  effect: Effect.Effect<A, SpaceCommandRejectedError | SpaceServiceError, R>,
) =>
  effect.pipe(
    Effect.tapError((error) =>
      error._tag === "SpaceServiceError"
        ? Effect.logWarning("space MCP tool: SpaceService failed", {
            operation,
            detail: Array.from(error.detail).slice(0, 500).join(""),
          })
        : Effect.void,
    ),
    Effect.mapError(rejected),
  );

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

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : value;

/** A stable hash of a call's arguments, so a reused key with other arguments is a new command. */
const argumentsHash = (args: unknown) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(canonical(args)))
    .digest("hex")
    .slice(0, 16);

/** Keys seen recently, to refuse a reused key; after a restart the hashed command id still differs. */
const MAX_REMEMBERED_KEYS = 1_000;

export const layer = McpToolAccess.toLayer(
  SpaceToolkit,
  Effect.sync(() => {
    const remembered = new Map<string, string>();

    const dispatch = Effect.fn("SpaceToolkit.dispatch")(function* (
      build: (
        commandId: CommandId,
      ) => Parameters<SpaceService.SpaceService["Service"]["dispatch"]>[0],
      operation: string,
      target: string,
      key: string,
      args: unknown,
    ) {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const spaces = yield* SpaceService.SpaceService;
      const hash = argumentsHash(args);
      const keyId = stableId("key", scope, [operation, key]);
      const previous = remembered.get(keyId);
      if (previous !== undefined && previous !== hash) return yield* reusedKey(key);
      const commandId = CommandId.make(stableId("command", scope, [operation, target, key, hash]));
      yield* spaceCall(operation, spaces.dispatch(build(commandId)));
      remembered.delete(keyId);
      remembered.set(keyId, hash);
      if (remembered.size > MAX_REMEMBERED_KEYS) {
        const oldest = remembered.keys().next();
        if (oldest.done !== true) remembered.delete(oldest.value);
      }
    });

    /** The given projects, all of which must exist, or the calling thread's project. */
    const resolveProjects = Effect.fn("SpaceToolkit.resolveProjects")(function* (
      projectIds: ReadonlyArray<ProjectId> | undefined,
    ) {
      if (projectIds === undefined) {
        const caller = yield* readCaller();
        return caller.caller === undefined ? undefined : [caller.caller.projectId];
      }
      if (projectIds.length === 0) return projectIds;
      const projects = yield* ProjectService.ProjectService;
      const found = yield* projects.listShells({ projectIds }).pipe(Effect.mapError(unavailable));
      const known = new Set<string>(found.map((project) => project.id));
      const unknown = projectIds.filter((projectId) => !known.has(projectId));
      if (unknown.length > 0)
        return yield* invalid(
          `Project ${unknown.join(", ")} was not found. Find projects with \`t3_project_list\`.`,
        );
      return projectIds;
    });

    return {
      space_list: McpToolAccess.reads(({ includeArchived }) =>
        Effect.gen(function* () {
          yield* requireSpaces;
          const spaces = yield* SpaceService.SpaceService;
          const listed = yield* spaceCall(
            "space_list",
            spaces.listSpaces({ includeArchived: includeArchived === true }),
          );
          return { spaces: listed.map(summary) };
        }),
      ),
      space_read: McpToolAccess.reads(({ spaceId }) =>
        Effect.gen(function* () {
          const scope = yield* requireSpaces;
          const spaces = yield* SpaceService.SpaceService;
          if (spaceId !== undefined) {
            const space = yield* spaceCall("space_read", spaces.getSpace(spaceId));
            if (Option.isNone(space)) return yield* spaceNotFound(spaceId);
            return { space: detail(space.value) };
          }
          if (scope.thread === undefined)
            return yield* new OrchestratorMcpFailure({
              code: "target_required",
              message: "Pass spaceId: this MCP client is not running inside a T3 thread.",
            });
          const space = yield* spaceCall(
            "space_read",
            spaces.spaceForThread(scope.thread.threadId),
          );
          return { space: Option.isNone(space) ? null : detail(space.value) };
        }),
      ),
      space_create: McpToolAccess.writes(
        ({ clientRequestId, ...fields }) =>
          Effect.gen(function* () {
            const scope = yield* requireLocalWriter;
            if (fields.brief !== undefined && fields.brief.length > 0) yield* requireBriefWriter;
            yield* checkBrief(fields.brief);
            const projectIds = yield* resolveProjects(fields.projectIds);
            const key = yield* requestKey(clientRequestId);
            // Derived from the retry key, so a retry finds the space it already made.
            const spaceId = SpaceId.make(stableId("space", scope, [key]));
            const command = {
              ...fields,
              ...(projectIds === undefined ? {} : { projectIds }),
            };
            yield* dispatch(
              (commandId) => ({ type: "space.create", commandId, spaceId, ...command }),
              "space-create",
              spaceId,
              key,
              fields,
            );
            return { spaceId };
          }),
        { linkedCallers: "allowed" },
      ),
      space_update: McpToolAccess.writes(
        ({ clientRequestId, spaceId, ...fields }) =>
          Effect.gen(function* () {
            yield* requireLocalWriter;
            if (fields.title !== undefined || fields.brief !== undefined) yield* requireBriefWriter;
            yield* checkBrief(fields.brief);
            yield* dispatch(
              (commandId) => ({ type: "space.update", commandId, spaceId, ...fields }),
              "space-update",
              spaceId,
              yield* requestKey(clientRequestId),
              { spaceId, ...fields },
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
              yield* requestKey(clientRequestId),
              { threadId, spaceId },
            );
            return { threadId, spaceId };
          }),
      ),
    };
  }),
);
