import type { ProjectId, ThreadId } from "@t3tools/contracts";

import type {
  Space,
  SpaceCommand,
  SpaceCommandRejectionReason,
  SpaceEvent,
  SpaceId,
  SpacesSnapshot,
} from "../contracts/space.ts";

/** Current spaces and thread memberships. The server projects it; clients mirror it. */
export interface SpacesState {
  readonly spaces: ReadonlyMap<SpaceId, Space>;
  readonly threadSpaces: ReadonlyMap<ThreadId, SpaceId>;
}

export const emptySpacesState: SpacesState = { spaces: new Map(), threadSpaces: new Map() };

export const spacesStateFromSnapshot = (snapshot: SpacesSnapshot): SpacesState => ({
  spaces: new Map(snapshot.spaces.map((space) => [space.id, space])),
  threadSpaces: new Map(snapshot.threadSpaces.map(({ threadId, spaceId }) => [threadId, spaceId])),
});

export const spacesSnapshotFromState = (state: SpacesState, sequence: number): SpacesSnapshot => ({
  sequence,
  spaces: [...state.spaces.values()],
  threadSpaces: [...state.threadSpaces].map(([threadId, spaceId]) => ({ threadId, spaceId })),
});

/** Pure reducer. Events for unknown spaces or threads are applied as far as they make sense. */
export const applySpaceEvent = (state: SpacesState, event: SpaceEvent): SpacesState => {
  switch (event.type) {
    case "space.created":
    case "space.updated": {
      const spaces = new Map(state.spaces);
      spaces.set(event.space.id, event.space);
      return { ...state, spaces };
    }
    case "space.deleted": {
      const spaces = new Map(state.spaces);
      spaces.delete(event.spaceId);
      const threadSpaces = new Map(
        [...state.threadSpaces].filter(([, spaceId]) => spaceId !== event.spaceId),
      );
      return { spaces, threadSpaces };
    }
    case "thread.space-updated": {
      const threadSpaces = new Map(state.threadSpaces);
      if (event.spaceId === null) threadSpaces.delete(event.threadId);
      else threadSpaces.set(event.threadId, event.spaceId);
      return { ...state, threadSpaces };
    }
  }
};

export type SpaceDecision =
  | { readonly _tag: "accepted"; readonly events: ReadonlyArray<SpaceEvent> }
  | {
      readonly _tag: "rejected";
      readonly reason: SpaceCommandRejectionReason;
      readonly detail: string;
    };

const accept = (...events: ReadonlyArray<SpaceEvent>): SpaceDecision => ({
  _tag: "accepted",
  events,
});
const reject = (reason: SpaceCommandRejectionReason, detail: string): SpaceDecision => ({
  _tag: "rejected",
  reason,
  detail,
});

const uniqueProjects = (projectIds: ReadonlyArray<ProjectId>) => [...new Set(projectIds)];

/**
 * Pure decider: no I/O. `now` is the command's accepted-at ISO time. Whether a thread exists is
 * checked by the service before deciding, because that needs the orchestration read model.
 * A command that changes nothing is accepted with no events.
 */
export const decideSpaceCommand = (
  state: SpacesState,
  command: SpaceCommand,
  now: string,
): SpaceDecision => {
  if (command.type === "thread.space.set") {
    const previousSpaceId = state.threadSpaces.get(command.threadId) ?? null;
    if (command.spaceId !== null) {
      const target = state.spaces.get(command.spaceId);
      if (target === undefined) return reject("space_not_found", command.spaceId);
      if (target.archivedAt !== null) return reject("space_archived", command.spaceId);
    }
    if (previousSpaceId === command.spaceId) return accept();
    return accept({
      type: "thread.space-updated",
      threadId: command.threadId,
      spaceId: command.spaceId,
      previousSpaceId,
    });
  }

  const existing = state.spaces.get(command.spaceId);
  if (command.type === "space.create") {
    if (existing !== undefined) return reject("space_exists", command.spaceId);
    return accept({
      type: "space.created",
      space: {
        id: command.spaceId,
        title: command.title,
        brief: command.brief ?? "",
        icon: command.icon ?? null,
        projectIds: uniqueProjects(command.projectIds ?? []),
        defaults: command.defaults ?? {},
        pinnedAt: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  if (existing === undefined) return reject("space_not_found", command.spaceId);

  const updated = (space: Space): SpaceDecision =>
    accept({ type: "space.updated", space: { ...space, updatedAt: now } });

  switch (command.type) {
    case "space.update": {
      if (existing.archivedAt !== null) return reject("space_archived", command.spaceId);
      const pinnedAt =
        command.pinned === undefined
          ? existing.pinnedAt
          : command.pinned
            ? (existing.pinnedAt ?? now)
            : null;
      const next: Space = {
        ...existing,
        title: command.title ?? existing.title,
        brief: command.brief ?? existing.brief,
        icon: command.icon === undefined ? existing.icon : command.icon,
        projectIds:
          command.projectIds === undefined
            ? existing.projectIds
            : uniqueProjects(command.projectIds),
        defaults: command.defaults ?? existing.defaults,
        pinnedAt,
      };
      return JSON.stringify(next) === JSON.stringify(existing) ? accept() : updated(next);
    }
    case "space.archive":
      return existing.archivedAt !== null
        ? accept()
        : updated({ ...existing, archivedAt: now, pinnedAt: null });
    case "space.unarchive":
      return existing.archivedAt === null ? accept() : updated({ ...existing, archivedAt: null });
    case "space.delete":
      return existing.archivedAt === null
        ? reject("space_not_archived", command.spaceId)
        : accept({ type: "space.deleted", spaceId: command.spaceId });
  }
};
