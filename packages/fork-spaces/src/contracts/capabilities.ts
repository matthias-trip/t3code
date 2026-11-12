import { ForwardCompatibleArray } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** A fork feature an environment can serve. */
export const ForkCapability = Schema.Literals(["spaces", "sources", "attention"]);
export type ForkCapability = typeof ForkCapability.Type;

/**
 * What a fork server advertises through `fork.capabilities`. Clients hide fork UI for anything
 * missing here, including everything when the environment is plain upstream T3 Code.
 *
 * Capabilities a newer server adds are dropped on decode instead of failing it, so an older client
 * keeps the features it knows rather than losing all of them.
 */
export const ForkCapabilities = Schema.Struct({
  protocolVersion: Schema.Int,
  capabilities: ForwardCompatibleArray(ForkCapability),
});
export type ForkCapabilities = typeof ForkCapabilities.Type;
