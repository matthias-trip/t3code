import type { Space, SpaceId } from "@t3tools/fork-spaces/contracts/space";
import { ChevronsUpDownIcon, InboxIcon, LayoutListIcon, PlusIcon } from "lucide-react";

import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../../components/ui/sidebar";
import { SpaceIcon } from "./SpaceIcon";
import { orderSwitcherSpaces, resolveCurrentSpace } from "./spaces.logic";

const ALL_WORK = "all";

export interface ForkSidebarTopProps {
  readonly spaces: ReadonlyArray<Space>;
  /** `null` is "All work", today's unfiltered sidebar. */
  readonly currentSpaceId: SpaceId | null;
  readonly onSelectSpace: (spaceId: SpaceId | null) => void;
  readonly onNewSpace: () => void;
  /** The Inbox row is hidden while this is undefined. */
  readonly inboxCount?: number | undefined;
  readonly inboxActive?: boolean;
  readonly onOpenInbox?: () => void;
}

/** Space switcher and Inbox entry for the top of the sidebar. */
export function ForkSidebarTop({
  spaces,
  currentSpaceId,
  onSelectSpace,
  onNewSpace,
  inboxCount,
  inboxActive = false,
  onOpenInbox,
}: ForkSidebarTopProps) {
  const current = resolveCurrentSpace(spaces, currentSpaceId);
  // An archived current space stays listed, marked, so the switcher still shows where you are.
  const active = orderSwitcherSpaces(spaces);
  const listed = current && current.archivedAt !== null ? [...active, current] : active;
  const currentTitle = current?.title ?? "All work";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Menu>
          <MenuTrigger
            render={<SidebarMenuButton aria-label={`Space: ${currentTitle}. Switch space`} />}
          >
            {current ? <SpaceIcon space={current} /> : <LayoutListIcon />}
            <span className="min-w-0 flex-1 truncate">{currentTitle}</span>
            <ChevronsUpDownIcon />
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuRadioGroup
              value={current?.id ?? ALL_WORK}
              onValueChange={(value: string) => {
                if (value === ALL_WORK) {
                  onSelectSpace(null);
                  return;
                }
                const space = listed.find((candidate) => candidate.id === value);
                if (space) onSelectSpace(space.id);
              }}
            >
              <MenuRadioItem value={ALL_WORK} closeOnClick>
                <span className="flex items-center gap-2">
                  <LayoutListIcon />
                  All work
                </span>
              </MenuRadioItem>
              {listed.map((space) => (
                <MenuRadioItem key={space.id} value={space.id} closeOnClick>
                  <span className="flex min-w-0 items-center gap-2">
                    <SpaceIcon space={space} />
                    <span className="min-w-0 truncate">{space.title}</span>
                    {space.archivedAt === null ? null : (
                      <span className="shrink-0 text-xs text-muted-foreground">Archived</span>
                    )}
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem onClick={onNewSpace}>
              <PlusIcon />
              New space…
            </MenuItem>
          </MenuPopup>
        </Menu>
      </SidebarMenuItem>
      {inboxCount === undefined ? null : (
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={inboxActive}
            aria-label={inboxCount > 0 ? `Inbox, ${inboxCount} waiting` : undefined}
            onClick={onOpenInbox}
          >
            <InboxIcon />
            <span className="min-w-0 flex-1 truncate">Inbox</span>
            {inboxCount > 0 ? (
              <span className="shrink-0 text-xs tabular-nums">{inboxCount}</span>
            ) : null}
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}
    </SidebarMenu>
  );
}
