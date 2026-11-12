import * as Layer from "effect/Layer";

import * as ForkEventStore from "./persistence/ForkEventStore.ts";
import { runForkMigrations } from "./persistence/ForkMigrations.ts";

const layerMigrations = Layer.effectDiscard(runForkMigrations());

/**
 * Fork services and fork migrations. Needs only SqlClient. Provide it from the upstream
 * persistence layer, whose SqlClient is available only after upstream migrations ran, so fork
 * migrations always run after them.
 */
export const layer = ForkEventStore.layer.pipe(Layer.provide(layerMigrations));
