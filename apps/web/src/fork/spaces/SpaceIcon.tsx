import { EnvironmentId } from "@t3tools/contracts";
import type { Space } from "@t3tools/fork-spaces/contracts/space";
import { LayersIcon } from "lucide-react";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import { cn } from "~/lib/utils";

// ProjectFavicon fetches a favicon only when there is no override, and a space with an icon
// always has one, so these fields are never read.
const NO_WORKSPACE = { environmentId: EnvironmentId.make("fork-space"), workspaceRoot: "" };

/** A space's icon, drawn like a project icon; a space without one gets a neutral glyph. */
export function SpaceIcon({
  space,
  className,
}: {
  readonly space: Pick<Space, "icon" | "title">;
  readonly className?: string | undefined;
}) {
  if (space.icon === null) {
    return (
      <LayersIcon
        aria-hidden="true"
        className={cn("size-3.5 shrink-0 text-icon-muted", className)}
      />
    );
  }
  return (
    <ProjectFavicon
      project={{ ...NO_WORKSPACE, title: space.title, faviconPath: null, projectIcon: space.icon }}
      className={className}
    />
  );
}
