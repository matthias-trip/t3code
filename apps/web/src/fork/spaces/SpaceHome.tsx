import type { Space } from "@t3tools/fork-spaces/contracts/space";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  EllipsisIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import { Textarea } from "../../components/ui/textarea";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { WorkspacePageContainer } from "../../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { SpaceIcon } from "./SpaceIcon";
import { type SpaceHomeTab, validateSpaceDraft, visibleSpaceHomeTabs } from "./spaceHome.logic";

/** One line in "Needs you" or "Sources": a title, a quiet detail, and at most one action. */
export interface SpaceHomeRow {
  readonly key: string;
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly detail?: ReactNode;
  readonly action?: { readonly label: string; readonly onAction: () => void };
}

export interface SpaceHomeProps {
  readonly space: Space;
  /** Display names of `space.projectIds`, in order. */
  readonly projectNames: ReadonlyArray<string>;
  readonly needsYou?: ReadonlyArray<SpaceHomeRow>;
  readonly sources?: ReadonlyArray<SpaceHomeRow>;
  /** Further tabs beside Overview (full sources, reactions, memory); empty ones are hidden. */
  readonly extraTabs?: ReadonlyArray<SpaceHomeTab<ReactNode>>;
  readonly onUpdate: (changes: { readonly title?: string; readonly brief?: string }) => void;
  readonly onSetPinned: (pinned: boolean) => void;
  readonly onArchive: () => void;
  readonly onUnarchive: () => void;
  /** Offered only for an archived space, after a confirmation. */
  readonly onDelete: () => void;
}

const OVERVIEW_TAB = "overview";

export function SpaceHome(props: SpaceHomeProps) {
  const { space } = props;
  const archived = space.archivedAt !== null;
  const [editing, setEditing] = useState(false);
  const [selectedTab, setSelectedTab] = useState(OVERVIEW_TAB);

  const needsYou = props.needsYou ?? [];
  const sources = props.sources ?? [];
  const hasOverview = space.brief.trim().length > 0 || needsYou.length > 0 || sources.length > 0;
  const tabs = visibleSpaceHomeTabs<ReactNode>([
    {
      value: OVERVIEW_TAB,
      label: "Overview",
      content: hasOverview ? (
        <SpaceOverview brief={space.brief} needsYou={needsYou} sources={sources} />
      ) : null,
    },
    ...(props.extraTabs ?? []),
  ]);
  const activeTab = tabs.find((tab) => tab.value === selectedTab) ?? tabs[0];

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <SpaceIcon space={space} />
            <span className="min-w-0 truncate text-sm font-medium">{space.title}</span>
          </div>
          <SpaceHomeActions
            space={space}
            onEdit={() => setEditing(true)}
            onSetPinned={props.onSetPinned}
            onArchive={props.onArchive}
            onUnarchive={props.onUnarchive}
            onDelete={props.onDelete}
          />
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer>
            {editing && !archived ? (
              <SpaceEditForm
                space={space}
                onCancel={() => setEditing(false)}
                onSave={(changes) => {
                  setEditing(false);
                  if (changes.title !== undefined || changes.brief !== undefined) {
                    props.onUpdate(changes);
                  }
                }}
              />
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  <h1 className="text-xl font-semibold">{space.title}</h1>
                  {props.projectNames.length > 0 ? (
                    <p className="text-sm text-muted-foreground">{props.projectNames.join(", ")}</p>
                  ) : null}
                  {archived ? <p className="text-sm text-muted-foreground">Archived</p> : null}
                </div>
                {tabs.length > 0 ? (
                  <ToggleGroup
                    aria-label="Space sections"
                    variant="segmented"
                    value={activeTab ? [activeTab.value] : []}
                    onValueChange={(value) => {
                      const next = value[0];
                      if (typeof next === "string") setSelectedTab(next);
                    }}
                  >
                    {tabs.map((tab) => (
                      <Toggle key={tab.value} value={tab.value}>
                        {tab.label}
                      </Toggle>
                    ))}
                  </ToggleGroup>
                ) : null}
                {tabs.length > 0
                  ? activeTab?.content
                  : hasOverview && (
                      <SpaceOverview brief={space.brief} needsYou={needsYou} sources={sources} />
                    )}
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function SpaceOverview(props: {
  readonly brief: string;
  readonly needsYou: ReadonlyArray<SpaceHomeRow>;
  readonly sources: ReadonlyArray<SpaceHomeRow>;
}) {
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {props.brief.trim().length > 0 ? <ChatMarkdown text={props.brief} cwd={undefined} /> : null}
      <SpaceHomeSection label="Needs you" rows={props.needsYou} />
      <SpaceHomeSection label="Sources" rows={props.sources} />
    </div>
  );
}

/** Renders nothing without rows: no empty-state chrome. */
function SpaceHomeSection(props: {
  readonly label: string;
  readonly rows: ReadonlyArray<SpaceHomeRow>;
}) {
  if (props.rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-1" aria-label={props.label}>
      <h2 className="text-xs font-medium text-muted-foreground">{props.label}</h2>
      <ul className="flex flex-col">
        {props.rows.map((row) => (
          <li key={row.key} className="flex min-h-9 items-center gap-3 text-sm">
            {row.icon}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{row.title}</span>
              {row.detail ? (
                <span className="truncate text-xs text-muted-foreground">{row.detail}</span>
              ) : null}
            </span>
            {row.action ? (
              <Button variant="outline" size="xs" onClick={row.action.onAction}>
                {row.action.label}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SpaceHomeActions(props: {
  readonly space: Space;
  readonly onEdit: () => void;
  readonly onSetPinned: (pinned: boolean) => void;
  readonly onArchive: () => void;
  readonly onUnarchive: () => void;
  readonly onDelete: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const archived = props.space.archivedAt !== null;
  const pinned = props.space.pinnedAt !== null;

  return (
    <div className="flex shrink-0 items-center gap-1">
      {archived ? (
        <Button variant="outline" size="sm" onClick={props.onUnarchive}>
          <ArchiveRestoreIcon />
          Unarchive
        </Button>
      ) : (
        <Button variant="ghost" size="sm" onClick={props.onEdit}>
          <PencilIcon />
          Edit
        </Button>
      )}
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label="More space actions" />}
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          {archived ? (
            <MenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
              <Trash2Icon />
              Delete space…
            </MenuItem>
          ) : (
            <>
              <MenuItem onClick={() => props.onSetPinned(!pinned)}>
                {pinned ? <PinOffIcon /> : <PinIcon />}
                {pinned ? "Unpin space" : "Pin space"}
              </MenuItem>
              <MenuItem onClick={props.onArchive}>
                <ArchiveIcon />
                Archive space
              </MenuItem>
            </>
          )}
        </MenuPopup>
      </Menu>
      <AlertDialog open={confirmingDelete && archived} onOpenChange={setConfirmingDelete}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{props.space.title}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Its threads stay and leave the space. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmingDelete(false);
                props.onDelete();
              }}
            >
              Delete space
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function SpaceEditForm(props: {
  readonly space: Space;
  readonly onCancel: () => void;
  readonly onSave: (changes: { readonly title?: string; readonly brief?: string }) => void;
}) {
  const [title, setTitle] = useState(props.space.title);
  const [brief, setBrief] = useState(props.space.brief);
  const [error, setError] = useState<{ field: "title" | "brief"; message: string } | null>(null);

  return (
    <form
      className="flex max-w-3xl flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const result = validateSpaceDraft(props.space, { title, brief });
        if (result._tag === "invalid") {
          setError({ field: result.field, message: result.message });
          return;
        }
        props.onSave(result.changes);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onCancel();
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="fork-space-title">Title</Label>
        <Input
          id="fork-space-title"
          value={title}
          autoFocus
          aria-invalid={error?.field === "title" || undefined}
          onChange={(event) => {
            setTitle(event.currentTarget.value);
            setError(null);
          }}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="fork-space-brief">Brief</Label>
        <Textarea
          id="fork-space-brief"
          value={brief}
          rows={6}
          placeholder="What this work is about. Agents in this space read it too."
          aria-invalid={error?.field === "brief" || undefined}
          onChange={(event) => {
            setBrief(event.currentTarget.value);
            setError(null);
          }}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error.message}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}
