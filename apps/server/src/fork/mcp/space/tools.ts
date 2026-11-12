import {
  McpCapabilityUnavailableError,
  OrchestratorMcpClientRequestId,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { SpaceBrief, SpaceId, SpaceTitle } from "@t3tools/fork-spaces/contracts/space";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SpaceService from "../../spaces/SpaceService.ts";

const shared = {
  failure: Schema.Union([OrchestratorMcpFailure, McpCapabilityUnavailableError]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    SpaceService.SpaceService,
    // Write declarations load the calling thread to check it is live.
    ThreadManagementService.ThreadManagementService,
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
    "List spaces: named groups of related threads and projects, each with a brief. Pinned first.",
  parameters: Schema.Struct({ includeArchived: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({ spaces: Schema.Array(SpaceSummary) }),
})
  .annotate(Tool.Title, "List spaces")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SpaceReadTool = Tool.make("space_read", {
  ...shared,
  description:
    "Read a space's title, brief, and projects. Omit `spaceId` for this thread's space; `space: null` if it has none.",
  parameters: Schema.Struct({ spaceId: Schema.optional(SpaceId) }),
  success: Schema.Struct({ space: Schema.NullOr(SpaceDetail) }),
})
  .annotate(Tool.Title, "Read space")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SpaceCreateTool = Tool.make("space_create", {
  ...shared,
  description:
    "Create a space for a piece of work. Moves no thread into it; then use `space_move_thread`.",
  parameters: Schema.Struct({
    title: SpaceTitle,
    brief: Schema.optional(
      SpaceBrief.annotate({ description: "Markdown context for agents in its threads." }),
    ),
    projectIds: Schema.optional(Schema.Array(ProjectId)),
    clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  }),
  success: Schema.Struct({ spaceId: SpaceId }),
})
  .annotate(Tool.Title, "Create space")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const SpaceUpdateTool = Tool.make("space_update", {
  ...shared,
  description: "Rename a space, replace its brief, or pin it. Omitted fields are unchanged.",
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
  .annotate(Tool.OpenWorld, false);

const SpaceMoveThreadTool = Tool.make("space_move_thread", {
  ...shared,
  description:
    "Put a thread (default: this one) in a space, or take it out with `spaceId: null`. A thread is in at most one space.",
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
  .annotate(Tool.OpenWorld, false);

export const SpaceToolkit = Toolkit.make(
  SpaceListTool,
  SpaceReadTool,
  SpaceCreateTool,
  SpaceUpdateTool,
  SpaceMoveThreadTool,
);
