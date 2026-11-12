import { ProjectId, ThreadId } from "@t3tools/contracts";
import { SpaceId, type Space } from "@t3tools/fork-spaces/contracts/space";
import {
  fixtureProjectIds,
  fixtureSpaceIds,
  fixtureSpacesSnapshot,
  fixtureThreadIds,
} from "@t3tools/fork-spaces/shared/spaceFixtures";
import { spacesStateFromSnapshot } from "@t3tools/fork-spaces/shared/spaces";
import { describe, expect, it } from "vite-plus/test";

import {
  collectThreadTags,
  filterThreadsBySpace,
  orderSwitcherSpaces,
  planSpaceFromTag,
  resolveCurrentSpace,
} from "./spaces.logic";

const payments = fixtureSpacesSnapshot.spaces[0]!;
const onboarding = fixtureSpacesSnapshot.spaces[1]!;
const state = spacesStateFromSnapshot(fixtureSpacesSnapshot);

const space = (overrides: Partial<Space> & Pick<Space, "id" | "title">): Space => ({
  ...onboarding,
  pinnedAt: null,
  archivedAt: null,
  ...overrides,
});

describe("orderSwitcherSpaces", () => {
  it("lists pinned spaces first in pin order, then the rest by title, and drops archived ones", () => {
    const spaces = [
      space({ id: SpaceId.make("space:z"), title: "Zeta" }),
      space({
        id: fixtureSpaceIds.archived,
        title: "Archived",
        archivedAt: "2026-10-01T00:00:00.000Z",
      }),
      space({
        id: SpaceId.make("space:p2"),
        title: "Pinned later",
        pinnedAt: "2026-11-10T00:00:00.000Z",
      }),
      space({ id: SpaceId.make("space:a"), title: "Alpha" }),
      space({
        id: SpaceId.make("space:p1"),
        title: "Pinned first",
        pinnedAt: "2026-11-01T00:00:00.000Z",
      }),
    ];
    expect(orderSwitcherSpaces(spaces).map((entry) => entry.title)).toEqual([
      "Pinned first",
      "Pinned later",
      "Alpha",
      "Zeta",
    ]);
  });
});

describe("resolveCurrentSpace", () => {
  it("reads a deleted space as All work", () => {
    expect(resolveCurrentSpace(fixtureSpacesSnapshot.spaces, payments.id)).toBe(payments);
    expect(resolveCurrentSpace(fixtureSpacesSnapshot.spaces, SpaceId.make("space:gone"))).toBe(
      null,
    );
  });
});

describe("filterThreadsBySpace", () => {
  const threads = Object.values(fixtureThreadIds).map((id) => ({ id }));

  it("keeps every thread for All work and only the space's threads otherwise", () => {
    expect(filterThreadsBySpace(threads, state.threadSpaces, null)).toBe(threads);
    expect(
      filterThreadsBySpace(threads, state.threadSpaces, onboarding.id).map((thread) => thread.id),
    ).toEqual([fixtureThreadIds.onboardingCopy]);
  });
});

describe("planSpaceFromTag", () => {
  const extraProject = ProjectId.make("project:docs");
  const threads = [
    {
      id: fixtureThreadIds.unfiled,
      projectId: fixtureProjectIds.checkout,
      archivedAt: null,
      tags: ["retry"],
    },
    { id: fixtureThreadIds.backoff, projectId: extraProject, archivedAt: null, tags: ["retry"] },
    {
      id: fixtureThreadIds.banner,
      projectId: extraProject,
      archivedAt: null,
      tags: ["retry", "ui"],
    },
    {
      id: ThreadId.make("thread:archived"),
      projectId: fixtureProjectIds.infra,
      archivedAt: "2026-11-01T00:00:00.000Z",
      tags: ["retry"],
    },
    { id: ThreadId.make("thread:untagged"), projectId: fixtureProjectIds.infra, archivedAt: null },
  ];

  it("takes unarchived tagged threads, orders projects by use, and flags threads already in a space", () => {
    expect(planSpaceFromTag({ tag: "retry", threads, threadSpaces: state.threadSpaces })).toEqual({
      title: "retry",
      projectIds: [extraProject, fixtureProjectIds.checkout],
      threadIds: [fixtureThreadIds.unfiled, fixtureThreadIds.backoff, fixtureThreadIds.banner],
      threadIdsInOtherSpaces: [fixtureThreadIds.backoff, fixtureThreadIds.banner],
    });
  });

  it("names the space from the trimmed tag, cut to the title limit, and refuses a blank one", () => {
    const tagged = (tag: string) => [{ ...threads[0]!, tags: [tag] }];
    const plan = (tag: string) =>
      planSpaceFromTag({ tag, threads: tagged(tag), threadSpaces: new Map() });
    expect(plan("  retry  ")?.title).toBe("retry");
    expect(plan(`${"x".repeat(119)} tail`)?.title).toBe("x".repeat(119));
    expect(plan("   ")).toBeNull();
  });

  it("collects tags from unarchived threads once each", () => {
    expect(collectThreadTags(threads)).toEqual(["retry", "ui"]);
  });
});
