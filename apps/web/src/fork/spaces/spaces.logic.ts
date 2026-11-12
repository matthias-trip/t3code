import type { ProjectId, ThreadId } from "@t3tools/contracts";
import type { Space, SpaceId } from "@t3tools/fork-spaces/contracts/space";

import { SPACE_TITLE_MAX } from "./spaceHome.logic";

/** Active spaces as the switcher lists them: pinned first, in pin order, then by title. */
export function orderSwitcherSpaces(spaces: ReadonlyArray<Space>): ReadonlyArray<Space> {
  return spaces
    .filter((space) => space.archivedAt === null)
    .toSorted((a, b) => {
      if (a.pinnedAt !== null && b.pinnedAt !== null) {
        return a.pinnedAt.localeCompare(b.pinnedAt) || a.id.localeCompare(b.id);
      }
      if (a.pinnedAt !== null) return -1;
      if (b.pinnedAt !== null) return 1;
      return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    });
}

/** The space a selection points at; a deleted space reads as "All work". */
export function resolveCurrentSpace(
  spaces: ReadonlyArray<Space>,
  currentSpaceId: SpaceId | null,
): Space | null {
  if (currentSpaceId === null) return null;
  return spaces.find((space) => space.id === currentSpaceId) ?? null;
}

/** Threads the sidebar shows for a selection; `null` is "All work". */
export function filterThreadsBySpace<TThread extends { readonly id: ThreadId }>(
  threads: ReadonlyArray<TThread>,
  threadSpaces: ReadonlyMap<ThreadId, SpaceId>,
  currentSpaceId: SpaceId | null,
): ReadonlyArray<TThread> {
  if (currentSpaceId === null) return threads;
  return threads.filter((thread) => threadSpaces.get(thread.id) === currentSpaceId);
}

export interface SpaceFromTagThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId | null;
  readonly archivedAt: string | null;
  readonly tags?: ReadonlyArray<string> | undefined;
}

export interface SpaceFromTagPlan {
  readonly title: string;
  /** Most-used project first, so it becomes the space's default for new threads. */
  readonly projectIds: ReadonlyArray<ProjectId>;
  readonly threadIds: ReadonlyArray<ThreadId>;
  /** Threads that would leave another space; the caller confirms before moving them. */
  readonly threadIdsInOtherSpaces: ReadonlyArray<ThreadId>;
}

/** `null` when the tag can't name a space (blank once trimmed). */
export function planSpaceFromTag(input: {
  readonly tag: string;
  readonly threads: ReadonlyArray<SpaceFromTagThread>;
  readonly threadSpaces: ReadonlyMap<ThreadId, SpaceId>;
}): SpaceFromTagPlan | null {
  // The same rules validateSpaceDraft applies, except a long tag is cut to fit.
  const title = input.tag.trim().slice(0, SPACE_TITLE_MAX).trimEnd();
  if (title.length === 0) return null;
  const tagged = input.threads.filter(
    (thread) => thread.archivedAt === null && (thread.tags ?? []).includes(input.tag),
  );
  const projectCounts = new Map<ProjectId, number>();
  for (const thread of tagged) {
    if (thread.projectId === null) continue;
    projectCounts.set(thread.projectId, (projectCounts.get(thread.projectId) ?? 0) + 1);
  }
  // Map keeps first-seen order, and the sort is stable, so ties keep it.
  const projectIds = [...projectCounts.entries()]
    .toSorted(([, a], [, b]) => b - a)
    .map(([projectId]) => projectId);
  return {
    title,
    projectIds,
    threadIds: tagged.map((thread) => thread.id),
    threadIdsInOtherSpaces: tagged
      .filter((thread) => input.threadSpaces.has(thread.id))
      .map((thread) => thread.id),
  };
}

/** Distinct tags on unarchived threads, in first-seen order. */
export function collectThreadTags(
  threads: ReadonlyArray<SpaceFromTagThread>,
): ReadonlyArray<string> {
  const tags = new Set<string>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    for (const tag of thread.tags ?? []) tags.add(tag);
  }
  return [...tags];
}
