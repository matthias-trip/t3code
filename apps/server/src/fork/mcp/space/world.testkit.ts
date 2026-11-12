import type {
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import {
  fixtureProjectIds,
  fixtureSpacesSnapshot,
} from "@t3tools/fork-spaces/shared/spaceFixtures";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as SpaceService from "../../spaces/SpaceService.ts";
import * as SpaceHandlers from "./handlers.ts";

const projectShell = (id: OrchestrationProjectShell["id"]): OrchestrationProjectShell => ({
  id,
  title: id,
  workspaceRoot: `/home/user/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/**
 * The space tools on the shared space fixtures: every thread is live and full-access in the
 * payments project unless `threads` says otherwise, and the fixture projects exist.
 */
export const spaceWorldLayer = (
  options: {
    readonly threads?: ReadonlyMap<ThreadId, Partial<OrchestrationV2ThreadShell>>;
    readonly missingThreadIds?: ReadonlyArray<ThreadId>;
  } = {},
) => {
  const projects = Object.values(fixtureProjectIds).map(projectShell);
  return McpToolAccess.HandlersLayer.layer(SpaceHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SpaceService.layerMemory({
          initial: fixtureSpacesSnapshot,
          ...(options.missingThreadIds === undefined
            ? {}
            : { missingThreadIds: options.missingThreadIds }),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed({
              ...liveThreadShell(threadId),
              projectId: fixtureProjectIds.payments,
              ...options.threads?.get(threadId),
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          listShells: (query) =>
            Effect.succeed(
              projects.filter(
                (project) =>
                  query?.projectIds === undefined || query.projectIds.includes(project.id),
              ),
            ),
        }),
        SecureRandom.layerWebCrypto,
      ),
    ),
  );
};
