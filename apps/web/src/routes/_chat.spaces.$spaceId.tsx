import { createFileRoute } from "@tanstack/react-router";

import { SpaceHomeRoute } from "../fork/spaces/SpaceHomeRoute";

export const Route = createFileRoute("/_chat/spaces/$spaceId")({
  component: SpaceHomeRoute,
});
