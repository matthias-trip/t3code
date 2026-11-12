import type { Space, SpaceId } from "@t3tools/fork-spaces/contracts/space";
import { FolderInputIcon, LayersIcon, LayoutListIcon, PlusIcon, TagIcon } from "lucide-react";

import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "../../components/CommandPalette.logic";
import { SpaceIcon } from "./SpaceIcon";
import { orderSwitcherSpaces } from "./spaces.logic";

type SpacePaletteItem = CommandPaletteActionItem | CommandPaletteSubmenuItem;

export interface SpacePaletteInput {
  readonly spaces: ReadonlyArray<Space>;
  readonly currentSpaceId: SpaceId | null;
  readonly onSwitchSpace: (spaceId: SpaceId | null) => Promise<void>;
  readonly onNewSpace: () => Promise<void>;
  /** The open thread, when there is one; "Move thread to space" needs it. */
  readonly activeThread?: { readonly spaceId: SpaceId | null } | undefined;
  readonly onMoveThread?: ((spaceId: SpaceId | null) => Promise<void>) | undefined;
  /** Tags on unarchived threads; "Make space from tag" is offered when there are any. */
  readonly threadTags?: ReadonlyArray<string> | undefined;
  readonly onMakeSpaceFromTag?: ((tag: string) => Promise<void>) | undefined;
}

function spaceItem(
  space: Space,
  valuePrefix: string,
  run: () => Promise<void>,
  extra: Partial<Pick<CommandPaletteActionItem, "description" | "secondary">> = {},
): CommandPaletteActionItem {
  return {
    kind: "action",
    value: `${valuePrefix}:${space.id}`,
    searchTerms: [space.title],
    title: space.title,
    icon: <SpaceIcon space={space} className="size-4" />,
    ...extra,
    run,
  };
}

/** Palette entries for spaces, for the palette's root action list. */
export function buildSpacePaletteItems(input: SpacePaletteInput): ReadonlyArray<SpacePaletteItem> {
  const active = orderSwitcherSpaces(input.spaces);
  const archived = input.spaces
    .filter((space) => space.archivedAt !== null)
    .toSorted((a, b) => a.title.localeCompare(b.title));
  const items: Array<SpacePaletteItem> = [];

  items.push({
    kind: "submenu",
    value: "action:fork-space:switch",
    searchTerms: ["switch space", "space", "filter", "all work"],
    title: "Switch space…",
    icon: <LayersIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <LayersIcon className={ADDON_ICON_CLASS} />,
    groups: [
      {
        value: "fork-space:switch",
        label: "Spaces",
        items: [
          {
            kind: "action",
            value: "fork-space:switch:all",
            searchTerms: ["all work", "all threads"],
            title: "All work",
            icon: <LayoutListIcon className={ITEM_ICON_CLASS} />,
            ...(input.currentSpaceId === null ? { secondary: true } : {}),
            run: () => input.onSwitchSpace(null),
          },
          ...active.map((space) =>
            spaceItem(
              space,
              "fork-space:switch",
              () => input.onSwitchSpace(space.id),
              space.id === input.currentSpaceId ? { secondary: true } : {},
            ),
          ),
          // Archived spaces stay reachable here, so they can be unarchived or deleted.
          ...archived.map((space) =>
            spaceItem(space, "fork-space:switch", () => input.onSwitchSpace(space.id), {
              description: "Archived",
              secondary: true,
            }),
          ),
        ],
      },
    ],
  });

  items.push({
    kind: "action",
    value: "action:fork-space:new",
    searchTerms: ["new space", "create space", "space"],
    title: "New space…",
    icon: <PlusIcon className={ITEM_ICON_CLASS} />,
    run: input.onNewSpace,
  });

  const { activeThread, onMoveThread } = input;
  if (activeThread && onMoveThread) {
    const targets = active.filter((space) => space.id !== activeThread.spaceId);
    if (targets.length > 0 || activeThread.spaceId !== null) {
      items.push({
        kind: "submenu",
        value: "action:fork-space:move-thread",
        searchTerms: ["move thread to space", "space", "move", "remove from space"],
        title: "Move thread to space…",
        icon: <FolderInputIcon className={ITEM_ICON_CLASS} />,
        addonIcon: <FolderInputIcon className={ADDON_ICON_CLASS} />,
        groups: [
          {
            value: "fork-space:move-thread",
            label: "Spaces",
            items: [
              ...targets.map((space) =>
                spaceItem(space, "fork-space:move-thread", () => onMoveThread(space.id)),
              ),
              ...(activeThread.spaceId !== null
                ? [
                    {
                      kind: "action" as const,
                      value: "fork-space:move-thread:remove",
                      searchTerms: ["remove from space", "no space"],
                      title: "Remove from space",
                      icon: <LayoutListIcon className={ITEM_ICON_CLASS} />,
                      run: () => onMoveThread(null),
                    },
                  ]
                : []),
            ],
          },
        ],
      });
    }
  }

  const { threadTags, onMakeSpaceFromTag } = input;
  if (threadTags && threadTags.length > 0 && onMakeSpaceFromTag) {
    items.push({
      kind: "submenu",
      value: "action:fork-space:from-tag",
      searchTerms: ["make space from tag", "tag", "space"],
      title: "Make space from tag…",
      icon: <TagIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <TagIcon className={ADDON_ICON_CLASS} />,
      groups: [
        {
          value: "fork-space:from-tag",
          label: "Tags",
          items: threadTags.map((tag) => ({
            kind: "action" as const,
            value: `fork-space:from-tag:${tag}`,
            searchTerms: [tag],
            title: tag,
            icon: <TagIcon className={ITEM_ICON_CLASS} />,
            run: () => onMakeSpaceFromTag(tag),
          })),
        },
      ],
    });
  }

  return items;
}
