import type { Space } from "@t3tools/fork-spaces/contracts/space";

// Mirrors SpaceTitle and SpaceBrief in the contract, so the form can say why it won't save.
const TITLE_MAX = 120;
const BRIEF_MAX = 20_000;

export type SpaceDraftResult =
  | {
      readonly _tag: "valid";
      /** Only fields that changed; empty when nothing did. */
      readonly changes: { readonly title?: string; readonly brief?: string };
    }
  | { readonly _tag: "invalid"; readonly field: "title" | "brief"; readonly message: string };

export function validateSpaceDraft(
  space: Pick<Space, "title" | "brief">,
  draft: { readonly title: string; readonly brief: string },
): SpaceDraftResult {
  const title = draft.title.trim();
  if (title.length === 0) {
    return { _tag: "invalid", field: "title", message: "A space needs a title." };
  }
  if (title.length > TITLE_MAX) {
    return {
      _tag: "invalid",
      field: "title",
      message: `Keep the title to ${TITLE_MAX} characters.`,
    };
  }
  if (draft.brief.length > BRIEF_MAX) {
    return {
      _tag: "invalid",
      field: "brief",
      message: `Keep the brief to ${BRIEF_MAX.toLocaleString("en-US")} characters.`,
    };
  }
  return {
    _tag: "valid",
    changes: {
      ...(title === space.title ? {} : { title }),
      ...(draft.brief === space.brief ? {} : { brief: draft.brief }),
    },
  };
}

export interface SpaceHomeTab<TContent> {
  readonly value: string;
  readonly label: string;
  /** `null` or `undefined` when the tab has nothing to show. */
  readonly content: TContent | null | undefined;
}

/** Tabs that have content, or none at all when fewer than two do (calm by default). */
export function visibleSpaceHomeTabs<TContent>(
  tabs: ReadonlyArray<SpaceHomeTab<TContent>>,
): ReadonlyArray<SpaceHomeTab<TContent> & { readonly content: TContent }> {
  const withContent = tabs.filter(
    (tab): tab is SpaceHomeTab<TContent> & { readonly content: TContent } =>
      tab.content !== null && tab.content !== undefined,
  );
  return withContent.length > 1 ? withContent : [];
}
