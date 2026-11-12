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

  it("round-trips state through a snapshot", () => {
    expect(spacesStateFromSnapshot(spacesSnapshotFromState(initial, 12))).toEqual(initial);
    expect(initial.threadSpaces.get(ThreadId.make("thread:unknown"))).toBeUndefined();
  });
});
