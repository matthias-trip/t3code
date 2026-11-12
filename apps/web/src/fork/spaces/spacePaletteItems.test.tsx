import type { SpaceId } from "@t3tools/fork-spaces/contracts/space";
import { fixtureSpaceIds, fixtureSpacesSnapshot } from "@t3tools/fork-spaces/shared/spaceFixtures";
import { describe, expect, it, vi } from "vite-plus/test";

import type { CommandPaletteSubmenuItem } from "../../components/CommandPalette.logic";
import { buildSpacePaletteItems, type SpacePaletteInput } from "./spacePaletteItems";

const base: SpacePaletteInput = {
  spaces: fixtureSpacesSnapshot.spaces,
  currentSpaceId: fixtureSpaceIds.payments,
  onSwitchSpace: async () => {},
  onNewSpace: async () => {},
};

const submenu = (input: SpacePaletteInput, value: string) =>
  buildSpacePaletteItems(input).find(
    (item): item is CommandPaletteSubmenuItem => item.kind === "submenu" && item.value === value,
  );
const entries = (item: CommandPaletteSubmenuItem | undefined) =>
  item?.groups.flatMap((group) => group.items) ?? [];

describe("buildSpacePaletteItems", () => {
  it("switches to All work or any space, with the current and archived ones last in rank", async () => {
    const onSwitchSpace = vi.fn(async (_spaceId: SpaceId | null) => {});
    const items = entries(submenu({ ...base, onSwitchSpace }, "action:fork-space:switch"));
    expect(items.map((item) => [item.title, item.secondary === true])).toEqual([
      ["All work", false],
      ["Payments retry redesign", true],
      ["Onboarding v3", false],
      ["Q3 cleanup", true],
    ]);
    const allWork = items[0];
    if (allWork?.kind !== "action") throw new Error("expected an action");
    await allWork.run();
    expect(onSwitchSpace).toHaveBeenCalledWith(null);
  });

  it("moves the open thread to another space or out of its own", async () => {
    const onMoveThread = vi.fn(async (_spaceId: SpaceId | null) => {});
    const items = entries(
      submenu(
        { ...base, activeThread: { spaceId: fixtureSpaceIds.payments }, onMoveThread },
        "action:fork-space:move-thread",
      ),
    );
    expect(items.map((item) => item.title)).toEqual(["Onboarding v3", "Remove from space"]);
    for (const item of items) if (item.kind === "action") await item.run();
    expect(onMoveThread.mock.calls).toEqual([[fixtureSpaceIds.onboarding], [null]]);
  });

  it("leaves out moving when no thread is open or there is nowhere to move it", () => {
    expect(submenu(base, "action:fork-space:move-thread")).toBeUndefined();
    const onlyOne = fixtureSpacesSnapshot.spaces.filter(
      (space) => space.id === fixtureSpaceIds.payments,
    );
    expect(
      submenu(
        {
          ...base,
          spaces: onlyOne,
          activeThread: { spaceId: null },
          onMoveThread: async () => {},
        },
        "action:fork-space:move-thread",
      ),
    ).toBeDefined();
    expect(
      submenu(
        {
          ...base,
          spaces: onlyOne,
          activeThread: { spaceId: fixtureSpaceIds.payments },
          onMoveThread: async () => {},
        },
        "action:fork-space:move-thread",
      ),
    ).toBeDefined();
    expect(
      submenu(
        { ...base, spaces: [], activeThread: { spaceId: null }, onMoveThread: async () => {} },
        "action:fork-space:move-thread",
      ),
    ).toBeUndefined();
  });

  it("offers making a space from a tag only when threads have tags", () => {
    const onMakeSpaceFromTag = async () => {};
    expect(
      submenu({ ...base, threadTags: [], onMakeSpaceFromTag }, "action:fork-space:from-tag"),
    ).toBeUndefined();
    expect(
      entries(
        submenu(
          { ...base, threadTags: ["retry"], onMakeSpaceFromTag },
          "action:fork-space:from-tag",
        ),
      ).map((item) => item.title),
    ).toEqual(["retry"]);
  });
});
