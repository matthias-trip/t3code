import * as Layer from "effect/Layer";

import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as ForkEventStore from "./persistence/ForkEventStore.ts";
import * as SpaceServiceLive from "./spaces/SpaceServiceLive.ts";
import { runForkMigrations } from "./persistence/ForkMigrations.ts";

const layerMigrations = Layer.effectDiscard(runForkMigrations());

/**
 * Fork services and fork migrations. Needs only SqlClient. Provide it from the upstream
 * persistence layer, whose SqlClient is available only after upstream migrations ran, so fork
 * migrations always run after them.
 */
export const layer = Layer.mergeAll(
  ForkEventStore.layer,
  // Thread-existence checks read upstream's thread projection, which needs only SqlClient.
  // `fork.capabilities` does not advertise "spaces" yet, so clients do not use it.
  SpaceServiceLive.layer.pipe(
    Layer.provide(ForkEventStore.layer),
    Layer.provide(ProjectionStoreV2.layer),
  ),
).pipe(Layer.provide(layerMigrations));
