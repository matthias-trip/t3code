import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { createForkCapabilitiesAtomFamily, forkCapabilitySet } from "./forkCapabilitiesQuery";

export const forkCapabilitiesAtom = createForkCapabilitiesAtomFamily(connectionAtomRuntime);

/** Fork features the environment serves; empty for plain upstream T3 Code. */
export function useForkCapabilities(environmentId: EnvironmentId) {
  return forkCapabilitySet(useAtomValue(forkCapabilitiesAtom(environmentId)));
}
