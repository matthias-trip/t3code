import { fixtureSpaceIds, fixtureSpacesSnapshot } from "@t3tools/fork-spaces/shared/spaceFixtures";
import { describe, expect, it } from "vite-plus/test";

import {
  buildMakeSpaceFromTagMenuItem,
  buildMoveToSpaceMenuItem,
  resolveSpaceMenuAction,
} from "./spaceMenus";

const spaces = fixtureSpacesSnapshot.spaces;

describe("buildMoveToSpaceMenuItem", () => {
  it("lists active spaces, marks the thread's own, and offers removal when it is in one", () => {
    const item = buildMoveToSpaceMenuItem({ spaces, threadSpaceId: fixtureSpaceIds.payments });
    expect(item?.children).toEqual([
      {
        id: `fork-space:move:${fixtureSpaceIds.payments}`,
        label: "Payments retry redesign",
        checked: true,
        disabled: true,
      },
      { id: `fork-space:move:${fixtureSpaceIds.onboarding}`, label: "Onboarding v3" },
      { id: "fork-space:remove", label: "Remove from space", separatorBefore: true },
    ]);
  });

  it("lets a thread leave an archived space even with no active space to move to", () => {
    const archivedOnly = spaces.filter((space) => space.archivedAt !== null);
    expect(
      buildMoveToSpaceMenuItem({ spaces: archivedOnly, threadSpaceId: fixtureSpaceIds.archived })
        ?.children,
    ).toEqual([{ id: "fork-space:remove", label: "Remove from space", separatorBefore: false }]);
    expect(buildMoveToSpaceMenuItem({ spaces: archivedOnly, threadSpaceId: null })).toBeNull();
  });

  it("disables every entry when the thread can't be changed", () => {
    const item = buildMoveToSpaceMenuItem({ spaces, threadSpaceId: null, disabled: true });
    expect(item?.disabled).toBe(true);
    expect(item?.children?.every((child) => child.disabled === true)).toBe(true);
  });
});

describe("buildMakeSpaceFromTagMenuItem", () => {
  it("is one entry for one tag, a submenu for several, and absent for none", () => {
    expect(buildMakeSpaceFromTagMenuItem({ tags: ["retry"] })).toEqual({
      id: "fork-space:from-tag:retry",
      label: 'Make space from "retry"',
      icon: "layers",
    });
    expect(
      buildMakeSpaceFromTagMenuItem({ tags: ["retry", "ui"] })?.children?.map((child) => child.id),
    ).toEqual(["fork-space:from-tag:retry", "fork-space:from-tag:ui"]);
    expect(buildMakeSpaceFromTagMenuItem({ tags: [] })).toBeNull();
  });
});

describe("resolveSpaceMenuAction", () => {
  it("maps the ids the builders make back to actions", () => {
    expect(resolveSpaceMenuAction(`fork-space:move:${fixtureSpaceIds.onboarding}`, spaces)).toEqual(
      { type: "move", spaceId: fixtureSpaceIds.onboarding },
    );
    expect(resolveSpaceMenuAction("fork-space:remove", spaces)).toEqual({
      type: "move",
      spaceId: null,
    });
    expect(resolveSpaceMenuAction("fork-space:from-tag:a:b", spaces)).toEqual({
      type: "make-space-from-tag",
      tag: "a:b",
    });
  });

  it("ignores other menus' ids and spaces deleted while the menu was open", () => {
    expect(resolveSpaceMenuAction("archive", spaces)).toBeNull();
    expect(resolveSpaceMenuAction("fork-space:move:space:gone", spaces)).toBeNull();
  });
});
