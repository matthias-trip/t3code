import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { Space } from "@t3tools/fork-spaces/contracts/space";
import {
  fixtureSpaceIds,
  fixtureSpacesSnapshot,
  fixtureThreadIds,
} from "@t3tools/fork-spaces/shared/spaceFixtures";
import { spacesStateFromSnapshot } from "@t3tools/fork-spaces/shared/spaces";

import {
  environmentSpaceLists,
  type EnvironmentSpaces,
  mergedSpaceLists,
  spaceById,
  spaceIdForThread,
  threadsInSpace,
  UNAVAILABLE_SPACES,
} from "./spaceState.ts";

const state = spacesStateFromSnapshot(fixtureSpacesSnapshot);
const space = (id: Space["id"]) => state.spaces.get(id)!;
const ready = (spaces: ReadonlyArray<Space>): EnvironmentSpaces => ({
  status: "ready",
  sequence: 1,
  state: spacesStateFromSnapshot({ sequence: 1, spaces, threadSpaces: [] }),
});

const titles = (spaces: ReadonlyArray<{ readonly title: string }>) =>
  spaces.map((entry) => entry.title);

describe("space selectors", () => {
  it("lists pinned spaces first, then the most recently updated, and archived apart", () => {
    const recent: Space = {
      ...space(fixtureSpaceIds.onboarding),
      id: "space:recent" as Space["id"],
      title: "Recent",
      updatedAt: "2026-11-12T08:00:00.000Z",
    };
    const lists = environmentSpaceLists(
      spacesStateFromSnapshot({
        ...fixtureSpacesSnapshot,
        spaces: [...state.spaces.values(), recent],
      }),
    );
    // The pinned space was updated before "Recent" but still comes first.
    expect(titles(lists.active)).toEqual(["Payments retry redesign", "Recent", "Onboarding v3"]);
    expect(titles(lists.archived)).toEqual(["Q3 cleanup"]);
  });

  it("finds a thread's space and a space's threads in the caller's order", () => {
    const spaceId = spaceIdForThread(state, fixtureThreadIds.banner);
    expect(spaceId).toBe(fixtureSpaceIds.payments);
    expect(spaceById(state, spaceId!)?.title).toBe("Payments retry redesign");
    expect(spaceIdForThread(state, fixtureThreadIds.unfiled)).toBeNull();
    const threads = [
      { id: fixtureThreadIds.banner },
      { id: fixtureThreadIds.unfiled },
      { id: fixtureThreadIds.onboardingCopy },
      { id: fixtureThreadIds.backoff },
      { id: ThreadId.make("thread:not-in-any-snapshot") },
    ];
    expect(threadsInSpace(state, fixtureSpaceIds.payments, threads)).toEqual([
      { id: fixtureThreadIds.banner },
      { id: fixtureThreadIds.backoff },
    ]);
  });

  it("merges environments into one ordered list, keeping where each space lives", () => {
    const local = EnvironmentId.make("local");
    const remote = EnvironmentId.make("remote");
    const remoteSpace: Space = {
      ...space(fixtureSpaceIds.onboarding),
      title: "Remote work",
      updatedAt: "2026-11-12T08:00:00.000Z",
    };
    const lists = mergedSpaceLists([
      { environmentId: local, spaces: { status: "ready", sequence: 12, state } },
      { environmentId: remote, spaces: ready([remoteSpace]) },
      { environmentId: EnvironmentId.make("upstream"), spaces: UNAVAILABLE_SPACES },
    ]);
    expect(lists.active.map(({ environmentId, space }) => [environmentId, space.title])).toEqual([
      [local, "Payments retry redesign"],
      [remote, "Remote work"],
      [local, "Onboarding v3"],
    ]);
    expect(lists.archived.map(({ environmentId }) => environmentId)).toEqual([local]);
  });
});
