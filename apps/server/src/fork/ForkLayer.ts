import * as Layer from "effect/Layer";

import * as ForkEventStore from "./persistence/ForkEventStore.ts";
import * as SpaceService from "./spaces/SpaceService.ts";
import { runForkMigrations } from "./persistence/ForkMigrations.ts";

const layerMigrations = Layer.effectDiscard(runForkMigrations());

/**
 * Fork services and fork migrations. Needs only SqlClient. Provide it from the upstream
 * persistence layer, whose SqlClient is available only after upstream migrations ran, so fork
 * migrations always run after them.
 */
export const layer = Layer.mergeAll(
  ForkEventStore.layer,
  // P1.0 freeze: the in-memory stub until P1.A replaces it with the persisted SpaceService.
  // `fork.capabilities` does not advertise "spaces" yet, so clients do not use it.
  SpaceService.layerMemory(),
).pipe(Layer.provide(layerMigrations));
