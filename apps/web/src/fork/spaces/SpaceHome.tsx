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
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";

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
import { WorkspacePageContainer } from "../../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { BRIEF_REMARK_PLUGINS } from "./briefMarkdown";
import { SpaceIcon } from "./SpaceIcon";
import { type SpaceHomeTab, spaceHomeLayout, validateSpaceDraft } from "./spaceHome.logic";

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
  // Edit and tab state belong to one space in one state: a draft never carries over to another
  // space, and archiving or unarchiving closes the form.
  const stateKey = `${props.space.id}:${props.space.archivedAt === null ? "active" : "archived"}`;
  return <SpaceHomeView key={stateKey} {...props} />;
}

function SpaceHomeView(props: SpaceHomeProps) {
  const { space } = props;
  const archived = space.archivedAt !== null;
  const [editing, setEditing] = useState(false);

  const needsYou = props.needsYou ?? [];
  const sources = props.sources ?? [];
  const hasOverview = space.brief.trim().length > 0 || needsYou.length > 0 || sources.length > 0;
  const layout = spaceHomeLayout<ReactNode>([
    {
      value: OVERVIEW_TAB,
      label: "Overview",
      content: hasOverview ? (
        <SpaceOverview brief={space.brief} needsYou={needsYou} sources={sources} />
      ) : null,
    },
    ...(props.extraTabs ?? []),
  ]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <SpaceIcon space={space} />
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
                {layout._tag === "tabs" ? (
                  <SpaceHomeTabs tabs={layout.tabs} />
                ) : layout._tag === "single" ? (
                  layout.content
                ) : null}
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

const TAB_KEYS: Record<string, (index: number, count: number) => number> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_index, count) => count - 1,
};

/** Tabs with automatic activation: arrow keys, Home and End move focus and selection. */
function SpaceHomeTabs(props: { readonly tabs: ReadonlyArray<SpaceHomeTab<ReactNode>> }) {
  const baseId = useId();
  const [selectedValue, setSelectedValue] = useState(OVERVIEW_TAB);
  const selectedIndex = Math.max(
    0,
    props.tabs.findIndex((tab) => tab.value === selectedValue),
  );
  const selected = props.tabs[selectedIndex];
  const tabId = (index: number) => `${baseId}-tab-${index}`;
  const panelId = (index: number) => `${baseId}-panel-${index}`;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = TAB_KEYS[event.key];
    if (!move) return;
    event.preventDefault();
    const next = move(selectedIndex, props.tabs.length);
    const tab = props.tabs[next];
    if (!tab) return;
    setSelectedValue(tab.value);
    document.getElementById(tabId(next))?.focus();
  };

  return (
    <>
      <div
        role="tablist"
        aria-label="Space sections"
        className="flex w-fit items-center gap-0.5 rounded-lg bg-muted p-0.5"
        onKeyDown={onKeyDown}
      >
        {props.tabs.map((tab, index) => {
          const active = index === selectedIndex;
          return (
            <button
              key={tab.value}
              id={tabId(index)}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={panelId(index)}
              tabIndex={active ? 0 : -1}
              className={cn(
                "rounded-md px-2.5 py-1 text-sm font-medium text-muted-foreground outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                active && "bg-background text-foreground shadow-xs",
              )}
              onClick={() => setSelectedValue(tab.value)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={panelId(selectedIndex)}
        aria-labelledby={tabId(selectedIndex)}
        tabIndex={0}
        className="outline-none"
      >
        {selected?.content}
      </div>
    </>
  );
}

function SpaceOverview(props: {
  readonly brief: string;
  readonly needsYou: ReadonlyArray<SpaceHomeRow>;
  readonly sources: ReadonlyArray<SpaceHomeRow>;
}) {
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {props.brief.trim().length > 0 ? (
        <ChatMarkdown
          text={props.brief}
          cwd={undefined}
          parseRawHtml={false}
          extraRemarkPlugins={BRIEF_REMARK_PLUGINS}
        />
      ) : null}
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
  const errorId = useId();

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
        // An IME composition, or a control inside that already handled Escape, keeps the form.
        if (event.key !== "Escape" || event.nativeEvent.isComposing || event.defaultPrevented) {
          return;
        }
        props.onCancel();
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="fork-space-title">Title</Label>
        <Input
          id="fork-space-title"
          value={title}
          autoFocus
          aria-invalid={error?.field === "title" || undefined}
          aria-describedby={error?.field === "title" ? errorId : undefined}
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
          aria-describedby={error?.field === "brief" ? errorId : undefined}
          onChange={(event) => {
            setBrief(event.currentTarget.value);
            setError(null);
          }}
        />
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive-foreground">
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
