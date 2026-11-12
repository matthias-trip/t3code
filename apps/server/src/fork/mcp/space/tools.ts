import {
  McpCapabilityUnavailableError,
  OrchestratorMcpClientRequestId,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { SpaceBrief, SpaceId, SpaceTitle } from "@t3tools/fork-spaces/contracts/space";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as McpSchema from "effect/ai/McpSchema";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SpaceService from "../../spaces/SpaceService.ts";

// Not in upstream's McpCapability list yet; the orchestrator adds it with the toolkit seam.
export const SPACES_CAPABILITY = "spaces";

/** Briefs agents write are shorter than the contract allows; people write the long ones. */
export const MCP_BRIEF_MAX_LENGTH = 4_000;

/**
 * `McpSchema.EnabledWhen`, as upstream's `hiddenFromSubagents`: credentials without "spaces"
 * are not shown the tools. Handlers still refuse them.
 */
export const shownWithSpaces = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope =
    fiber && Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext);
  const granted: ReadonlySet<string> | undefined = scope?.capabilities;
  return granted?.has(SPACES_CAPABILITY) === true;
};

const shared = {
  failure: Schema.Union([OrchestratorMcpFailure, McpCapabilityUnavailableError]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    SpaceService.SpaceService,
    // Write declarations load the calling thread to check it is live.
    ThreadManagementService.ThreadManagementService,
    // `space_create` checks the projects it is given.
    ProjectService.ProjectService,
    SecureRandom.SecureRandom,
  ],
};

const SpaceSummary = Schema.Struct({
  spaceId: SpaceId,
  title: Schema.String,
  pinned: Schema.Boolean,
  archived: Schema.Boolean,
});

const SpaceDetail = Schema.Struct({
  ...SpaceSummary.fields,
  brief: Schema.String,
  projectIds: Schema.Array(ProjectId),
});

const SpaceListTool = Tool.make("space_list", {
  ...shared,
  description:
    "List spaces (named groups of related threads and projects, with a brief for agents). Pinned first.",
  parameters: Schema.Struct({ includeArchived: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({ spaces: Schema.Array(SpaceSummary) }),
})
  .annotate(Tool.Title, "List spaces")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, shownWithSpaces);

const SpaceReadTool = Tool.make("space_read", {
  ...shared,
  description: "Read a space. Omit `spaceId` for this thread's space; `space: null` if none.",
  parameters: Schema.Struct({ spaceId: Schema.optional(SpaceId) }),
  success: Schema.Struct({ space: Schema.NullOr(SpaceDetail) }),
})
  .annotate(Tool.Title, "Read space")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, shownWithSpaces);

const SpaceCreateTool = Tool.make("space_create", {
  ...shared,
  description: "Create a space. Moves no thread; use `space_move_thread`. Brief: max 4000 chars.",
  parameters: Schema.Struct({
    title: SpaceTitle,
    brief: Schema.optional(SpaceBrief),
    projectIds: Schema.optional(Schema.Array(ProjectId)),
    clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  }),
  success: Schema.Struct({ spaceId: SpaceId }),
})
  .annotate(Tool.Title, "Create space")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, shownWithSpaces);

const SpaceUpdateTool = Tool.make("space_update", {
  ...shared,
  description: "Rename, replace the brief (max 4000 chars), or pin. Omitted fields stay.",
  parameters: Schema.Struct({
    spaceId: SpaceId,
    title: Schema.optional(SpaceTitle),
    brief: Schema.optional(SpaceBrief),
    pinned: Schema.optional(Schema.Boolean),
    clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  }),
  success: Schema.Struct({ spaceId: SpaceId }),
})
  .annotate(Tool.Title, "Update space")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, shownWithSpaces);

const SpaceMoveThreadTool = Tool.make("space_move_thread", {
  ...shared,
  description:
    "Put a thread (default: this one) in a space, or out with `spaceId: null`. One space per thread.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    spaceId: Schema.NullOr(SpaceId),
    clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  }),
  success: Schema.Struct({ threadId: ThreadId, spaceId: Schema.NullOr(SpaceId) }),
})
  .annotate(Tool.Title, "Move thread to space")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, shownWithSpaces);

export const SpaceToolkit = Toolkit.make(
  SpaceListTool,
  SpaceReadTool,
  SpaceCreateTool,
  SpaceUpdateTool,
  SpaceMoveThreadTool,
);
