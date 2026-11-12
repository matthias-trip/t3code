import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { SpaceId, type SpaceCommand } from "../contracts/space.ts";
import {
  fixtureCommandId,
  fixtureProjectIds,
  fixtureSpaceIds,
  fixtureSpacesSnapshot,
  fixtureThreadIds,
} from "./spaceFixtures.ts";
import {
  applySpaceEvent,
  decideSpaceCommand,
  spacesSnapshotFromState,
  spacesStateFromSnapshot,
  type SpacesState,
} from "./spaces.ts";

const now = "2026-11-12T12:00:00.000Z";
const initial = spacesStateFromSnapshot(fixtureSpacesSnapshot);

const run = (state: SpacesState, command: SpaceCommand) => {
  const decision = decideSpaceCommand(state, command, now);
  if (decision._tag === "rejected") return { state, decision };
  return { state: decision.events.reduce(applySpaceEvent, state), decision };
};

describe("decideSpaceCommand", () => {
  it("creates a space with defaults and de-duplicated projects", () => {
    const { state, decision } = run(initial, {
      type: "space.create",
      commandId: fixtureCommandId("create"),
      spaceId: SpaceId.make("space:new"),
      title: "New work",
      projectIds: [fixtureProjectIds.infra, fixtureProjectIds.infra, fixtureProjectIds.payments],
    });
    expect(decision._tag).toBe("accepted");
    expect(state.spaces.get(SpaceId.make("space:new"))).toMatchObject({
      brief: "",
      icon: null,
      projectIds: [fixtureProjectIds.infra, fixtureProjectIds.payments],
      createdAt: now,
      archivedAt: null,
    });
  });

  it("archives, rejects edits and moves into it, unarchives, and deletes only when archived", () => {
    const spaceId = fixtureSpaceIds.onboarding;
    const live = run(initial, { type: "space.delete", commandId: fixtureCommandId("d0"), spaceId });
    expect(live.decision).toMatchObject({ _tag: "rejected", reason: "space_not_archived" });

    const archived = run(initial, {
      type: "space.archive",
      commandId: fixtureCommandId("a"),
      spaceId,
    });
    expect(archived.state.spaces.get(spaceId)?.archivedAt).toBe(now);
    expect(
      run(archived.state, {
        type: "thread.space.set",
        commandId: fixtureCommandId("m"),
        threadId: fixtureThreadIds.unfiled,
        spaceId,
      }).decision,
    ).toMatchObject({ _tag: "rejected", reason: "space_archived" });

    const restored = run(archived.state, {
      type: "space.unarchive",
      commandId: fixtureCommandId("u"),
      spaceId,
    });
    expect(restored.state.spaces.get(spaceId)?.archivedAt).toBeNull();

    const deleted = run(archived.state, {
      type: "space.delete",
      commandId: fixtureCommandId("d1"),
      spaceId,
    });
    expect(deleted.state.spaces.has(spaceId)).toBe(false);
    expect(deleted.state.threadSpaces.has(fixtureThreadIds.onboardingCopy)).toBe(false);
  });

  it("moves a thread between spaces and out again, recording where it came from", () => {
    const moved = run(initial, {
      type: "thread.space.set",
      commandId: fixtureCommandId("m1"),
      threadId: fixtureThreadIds.backoff,
      spaceId: fixtureSpaceIds.onboarding,
    });
    expect(moved.decision).toMatchObject({
      _tag: "accepted",
      events: [{ type: "thread.space-updated", previousSpaceId: fixtureSpaceIds.payments }],
    });
    const out = run(moved.state, {
      type: "thread.space.set",
      commandId: fixtureCommandId("m2"),
      threadId: fixtureThreadIds.backoff,
      spaceId: null,
    });
    expect(out.state.threadSpaces.has(fixtureThreadIds.backoff)).toBe(false);
  });

  it("accepts a no-op with no events", () => {
    expect(
      decideSpaceCommand(
        initial,
        {
          type: "thread.space.set",
          commandId: fixtureCommandId("same"),
          threadId: fixtureThreadIds.backoff,
          spaceId: fixtureSpaceIds.payments,
        },
        now,
      ),
    ).toEqual({ _tag: "accepted", events: [] });
    expect(
      decideSpaceCommand(
        initial,
        {
          type: "space.update",
          commandId: fixtureCommandId("u0"),
          spaceId: fixtureSpaceIds.onboarding,
        },
        now,
      ),
    ).toEqual({ _tag: "accepted", events: [] });
  });

  it("pins once, keeps the first pin time, and unpins", () => {
    const spaceId = fixtureSpaceIds.onboarding;
    const pinned = run(initial, {
      type: "space.update",
      commandId: fixtureCommandId("p1"),
      spaceId,
      pinned: true,
    });
    expect(pinned.state.spaces.get(spaceId)?.pinnedAt).toBe(now);
    const later = "2026-11-13T12:00:00.000Z";
    expect(
      decideSpaceCommand(
        pinned.state,
        { type: "space.update", commandId: fixtureCommandId("p2"), spaceId, pinned: true },
        later,
      ),
    ).toEqual({ _tag: "accepted", events: [] });
    const unpinned = run(pinned.state, {
      type: "space.update",
      commandId: fixtureCommandId("p3"),
      spaceId,
      pinned: false,
    });
    expect(unpinned.state.spaces.get(spaceId)?.pinnedAt).toBeNull();
    expect(
      run(unpinned.state, {
        type: "space.update",
        commandId: fixtureCommandId("p4"),
        spaceId,
        pinned: false,
      }).decision,
    ).toEqual({ _tag: "accepted", events: [] });
  });

  it("updates only the given fields, clears the icon on null, and stamps updatedAt", () => {
    const spaceId = fixtureSpaceIds.payments;
    const before = initial.spaces.get(spaceId)!;
    const { state } = run(initial, {
      type: "space.update",
      commandId: fixtureCommandId("u1"),
      spaceId,
      brief: "",
      icon: null,
      projectIds: [fixtureProjectIds.infra, fixtureProjectIds.infra],
    });
    expect(state.spaces.get(spaceId)).toEqual({
      ...before,
      brief: "",
      icon: null,
      projectIds: [fixtureProjectIds.infra],
      updatedAt: now,
    });
  });

  it("unpins on archive, and treats archive of archived and unarchive of live as no-ops", () => {
    const pinned = fixtureSpaceIds.payments;
    const archived = run(initial, {
      type: "space.archive",
      commandId: fixtureCommandId("a1"),
      spaceId: pinned,
    });
    expect(archived.state.spaces.get(pinned)).toMatchObject({ archivedAt: now, pinnedAt: null });
    for (const command of [
      { type: "space.archive", spaceId: fixtureSpaceIds.archived },
      { type: "space.unarchive", spaceId: fixtureSpaceIds.onboarding },
    ] as const) {
      expect(
        decideSpaceCommand(initial, { ...command, commandId: fixtureCommandId("noop") }, now),
      ).toEqual({ _tag: "accepted", events: [] });
    }
    expect(
      run(initial, {
        type: "space.update",
        commandId: fixtureCommandId("u2"),
        spaceId: fixtureSpaceIds.archived,
        title: "Edited",
      }).decision,
    ).toMatchObject({ _tag: "rejected", reason: "space_archived" });
  });

  it("rejects commands on missing spaces and a second create of the same id", () => {
    const missing = SpaceId.make("space:missing");
    const commands: ReadonlyArray<SpaceCommand> = [
      { type: "space.update", commandId: fixtureCommandId("m1"), spaceId: missing, title: "X" },
      { type: "space.archive", commandId: fixtureCommandId("m2"), spaceId: missing },
      { type: "space.unarchive", commandId: fixtureCommandId("m3"), spaceId: missing },
      { type: "space.delete", commandId: fixtureCommandId("m4"), spaceId: missing },
      {
        type: "thread.space.set",
        commandId: fixtureCommandId("m5"),
        threadId: fixtureThreadIds.unfiled,
        spaceId: missing,
      },
    ];
    for (const command of commands) {
      expect(decideSpaceCommand(initial, command, now)).toEqual({
        _tag: "rejected",
        reason: "space_not_found",
        detail: missing,
      });
    }
    expect(
      decideSpaceCommand(
        initial,
        {
          type: "space.create",
          commandId: fixtureCommandId("c2"),
          spaceId: fixtureSpaceIds.payments,
          title: "Again",
        },
        now,
      ),
    ).toMatchObject({ _tag: "rejected", reason: "space_exists" });
  });

  it("takes a thread out of an archived space, and out of no space as a no-op", () => {
    const archived = run(initial, {
      type: "space.archive",
      commandId: fixtureCommandId("a2"),
      spaceId: fixtureSpaceIds.onboarding,
    });
    const out = run(archived.state, {
      type: "thread.space.set",
      commandId: fixtureCommandId("o1"),
      threadId: fixtureThreadIds.onboardingCopy,
      spaceId: null,
    });
    expect(out.decision).toEqual({
      _tag: "accepted",
      events: [
        {
          type: "thread.space-updated",
          threadId: fixtureThreadIds.onboardingCopy,
          spaceId: null,
          previousSpaceId: fixtureSpaceIds.onboarding,
        },
      ],
    });
    expect(
      decideSpaceCommand(
        initial,
        {
          type: "thread.space.set",
          commandId: fixtureCommandId("o2"),
          threadId: fixtureThreadIds.unfiled,
          spaceId: null,
        },
        now,
      ),
    ).toEqual({ _tag: "accepted", events: [] });
  });

  it("round-trips state through a snapshot", () => {
    expect(spacesStateFromSnapshot(spacesSnapshotFromState(initial, 12))).toEqual(initial);
    expect(initial.threadSpaces.get(ThreadId.make("thread:unknown"))).toBeUndefined();
  });
});
