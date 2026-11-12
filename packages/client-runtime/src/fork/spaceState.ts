import { isUnknownUnionMember, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import type { Space, SpaceId, SpacesStreamItem } from "@t3tools/fork-spaces/contracts/space";
import {
  applySpaceEvent,
  emptySpacesState,
  spacesStateFromSnapshot,
  type SpacesState,
} from "@t3tools/fork-spaces/shared/spaces";

/**
 * `unavailable`: the environment does not offer spaces (an upstream server). `failed`: the
 * subscription failed before any snapshot; the next session retries. `ready` mirrors the server
 * as of `sequence` and keeps its state through later failures.
 */
export type EnvironmentSpaces =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly sequence: number; readonly state: SpacesState };

export const LOADING_SPACES: EnvironmentSpaces = { status: "loading" };
export const UNAVAILABLE_SPACES: EnvironmentSpaces = { status: "unavailable" };

/** What one subscription delivers: a stream item, or the failure that ended it. */
export type SpacesSyncInput =
  | SpacesStreamItem
  | { readonly type: "failed"; readonly message: string };

/**
 * A snapshot replaces local state. An event applies only after a snapshot and only when its
 * sequence is newer than the last one seen; an event type this client does not know advances
 * the sequence and changes nothing else.
 */
export const reduceEnvironmentSpaces = (
  current: EnvironmentSpaces,
  input: SpacesSyncInput,
): EnvironmentSpaces => {
  switch (input.type) {
    case "snapshot":
      return {
        status: "ready",
        sequence: input.snapshot.sequence,
        state: spacesStateFromSnapshot(input.snapshot),
      };
    case "event": {
      if (current.status !== "ready" || input.sequence <= current.sequence) return current;
      return {
        status: "ready",
        sequence: input.sequence,
        state: isUnknownUnionMember(input.event)
          ? current.state
          : applySpaceEvent(current.state, input.event),
      };
    }
    case "failed":
      return current.status === "ready" ? current : { status: "failed", message: input.message };
  }
};

/** The spaces state to select from; empty until ready. */
const spacesStateOf = (spaces: EnvironmentSpaces): SpacesState =>
  spaces.status === "ready" ? spaces.state : emptySpacesState;

export interface SpaceLists<A> {
  /** Pinned first, then the most recently updated. */
  readonly active: ReadonlyArray<A>;
  /** Most recently archived first. */
  readonly archived: ReadonlyArray<A>;
}

const byNewest = (left: string, right: string) => (left < right ? 1 : left > right ? -1 : 0);

const compareActive = (left: Space, right: Space) => {
  const pinned = Number(right.pinnedAt !== null) - Number(left.pinnedAt !== null);
  return pinned !== 0 ? pinned : byNewest(left.updatedAt, right.updatedAt);
};

const compareArchived = (left: Space, right: Space) =>
  byNewest(left.archivedAt ?? left.updatedAt, right.archivedAt ?? right.updatedAt);

const splitSpaces = <A>(items: Iterable<A>, spaceOf: (item: A) => Space): SpaceLists<A> => {
  const active: Array<A> = [];
  const archived: Array<A> = [];
  for (const item of items) (spaceOf(item).archivedAt === null ? active : archived).push(item);
  active.sort((left, right) => compareActive(spaceOf(left), spaceOf(right)));
  archived.sort((left, right) => compareArchived(spaceOf(left), spaceOf(right)));
  return { active, archived };
};

export const environmentSpaceLists = (state: SpacesState): SpaceLists<Space> =>
  splitSpaces(state.spaces.values(), (space) => space);

export const spaceById = (state: SpacesState, spaceId: SpaceId): Space | null =>
  state.spaces.get(spaceId) ?? null;

export const spaceIdForThread = (state: SpacesState, threadId: ThreadId): SpaceId | null =>
  state.threadSpaces.get(threadId) ?? null;

/** The caller's threads that are in `spaceId`, in the caller's order. */
export const threadsInSpace = <T extends { readonly id: ThreadId }>(
  state: SpacesState,
  spaceId: SpaceId,
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> => threads.filter((thread) => state.threadSpaces.get(thread.id) === spaceId);

export interface EnvironmentSpace {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
}

/** Every environment's spaces in one list, ordered as within one environment. */
export const mergedSpaceLists = (
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly spaces: EnvironmentSpaces;
  }>,
): SpaceLists<EnvironmentSpace> =>
  splitSpaces(
    environments.flatMap(({ environmentId, spaces }) =>
      [...spacesStateOf(spaces).spaces.values()].map((space) => ({ environmentId, space })),
    ),
    (entry) => entry.space,
  );
