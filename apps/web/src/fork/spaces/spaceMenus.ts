import type { ContextMenuItem } from "@t3tools/contracts";
import type { Space, SpaceId } from "@t3tools/fork-spaces/contracts/space";

import { orderSwitcherSpaces } from "./spaces.logic";

const MOVE_PREFIX = "fork-space:move:";
const FROM_TAG_PREFIX = "fork-space:from-tag:";

export type SpaceMenuId =
  | "fork-space:move"
  | `fork-space:move:${string}`
  | "fork-space:remove"
  | "fork-space:from-tag"
  | `fork-space:from-tag:${string}`;

export type SpaceMenuAction =
  | { readonly type: "move"; readonly spaceId: SpaceId | null }
  | { readonly type: "make-space-from-tag"; readonly tag: string };

/** "Move to space" for a thread's context menu; null when there is nowhere to move it. */
export function buildMoveToSpaceMenuItem(input: {
  readonly spaces: ReadonlyArray<Space>;
  readonly threadSpaceId: SpaceId | null;
  readonly disabled?: boolean;
}): ContextMenuItem<SpaceMenuId> | null {
  const targets = orderSwitcherSpaces(input.spaces);
  // An archived space is not a target, but a thread in one can still leave it.
  const canRemove = input.threadSpaceId !== null;
  if (targets.length === 0 && !canRemove) return null;
  const disabled = input.disabled === true;
  return {
    id: "fork-space:move",
    label: "Move to space",
    icon: "layers",
    ...(disabled ? { disabled } : {}),
    children: [
      ...targets.map((space) => ({
        id: `${MOVE_PREFIX}${space.id}` as const,
        label: space.title,
        ...(space.id === input.threadSpaceId ? { checked: true, disabled: true } : {}),
        ...(disabled ? { disabled } : {}),
      })),
      ...(canRemove
        ? [
            {
              id: "fork-space:remove" as const,
              label: "Remove from space",
              separatorBefore: targets.length > 0,
              ...(disabled ? { disabled } : {}),
            },
          ]
        : []),
    ],
  };
}

/** "Make space from tag" for a thread with tags; one entry per tag. */
export function buildMakeSpaceFromTagMenuItem(input: {
  readonly tags: ReadonlyArray<string>;
  readonly disabled?: boolean;
}): ContextMenuItem<SpaceMenuId> | null {
  const [onlyTag] = input.tags;
  if (onlyTag === undefined) return null;
  const disabled = input.disabled === true ? { disabled: true } : {};
  if (input.tags.length === 1) {
    return {
      id: `${FROM_TAG_PREFIX}${onlyTag}`,
      label: `Make space from "${onlyTag}"`,
      icon: "layers",
      ...disabled,
    };
  }
  return {
    id: "fork-space:from-tag",
    label: "Make space from tag",
    icon: "layers",
    ...disabled,
    children: input.tags.map((tag) => ({
      id: `${FROM_TAG_PREFIX}${tag}` as const,
      label: tag,
      ...disabled,
    })),
  };
}

/** Maps a clicked menu id back to an action; null for ids these builders did not make. */
export function resolveSpaceMenuAction(
  id: string,
  spaces: ReadonlyArray<Space>,
): SpaceMenuAction | null {
  if (id === "fork-space:remove") return { type: "move", spaceId: null };
  if (id.startsWith(MOVE_PREFIX)) {
    const space = spaces.find((candidate) => candidate.id === id.slice(MOVE_PREFIX.length));
    return space ? { type: "move", spaceId: space.id } : null;
  }
  if (id.startsWith(FROM_TAG_PREFIX)) {
    return { type: "make-space-from-tag", tag: id.slice(FROM_TAG_PREFIX.length) };
  }
  return null;
}
