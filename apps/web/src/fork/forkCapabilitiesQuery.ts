import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { request } from "@t3tools/client-runtime/rpc";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ForkCapabilities, ForkCapability } from "@t3tools/fork-spaces/contracts/capabilities";
import { FORK_WS_METHODS } from "@t3tools/fork-spaces/contracts/rpc";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult, type Atom } from "effect/reactivity";

/** What a plain upstream T3 Code environment offers: no fork features at all. */
export const UPSTREAM_FORK_CAPABILITIES: ForkCapabilities = {
  protocolVersion: 0,
  capabilities: [],
};

const UNKNOWN_TAG_PREFIX = `Unknown request tag: ${FORK_WS_METHODS.capabilities}`;

const defectMessage = (defect: unknown): string | undefined => {
  if (typeof defect === "string") return defect;
  if (typeof defect === "object" && defect !== null && "message" in defect) {
    return typeof defect.message === "string" ? defect.message : undefined;
  }
  return undefined;
};

/** Effect's RpcServer answers a tag it doesn't serve with this per-request defect. */
const isUnknownForkRpcCause = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some(
    (reason) =>
      Cause.isDieReason(reason) &&
      (defectMessage(reason.defect)?.startsWith(UNKNOWN_TAG_PREFIX) ?? false),
  );

const recoverUpstreamForkCapabilities = <E, R>(
  effect: Effect.Effect<ForkCapabilities, E, R>,
): Effect.Effect<ForkCapabilities, E, R> =>
  Effect.catchCauseIf(effect, isUnknownForkRpcCause, () =>
    Effect.succeed(UPSTREAM_FORK_CAPABILITIES),
  );

// Fork UI stays hidden until an answer arrives, and after any failure.
export const forkCapabilitySet = (
  result: AsyncResult.AsyncResult<ForkCapabilities, unknown>,
): ReadonlySet<ForkCapability> =>
  new Set(AsyncResult.getOrElse(result, () => UPSTREAM_FORK_CAPABILITIES).capabilities);

export function createForkCapabilitiesAtomFamily<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
) {
  const family = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:fork:capabilities",
    tag: FORK_WS_METHODS.capabilities,
    // Capabilities change only with the server build; a new session re-runs the query anyway.
    staleTimeMs: Number.POSITIVE_INFINITY,
    execute: (input) =>
      recoverUpstreamForkCapabilities(request(FORK_WS_METHODS.capabilities, input)),
  });
  return (environmentId: EnvironmentId) => family({ environmentId, input: {} });
}
