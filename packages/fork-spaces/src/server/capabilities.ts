import type { ForkCapabilities } from "../contracts/capabilities.ts";
import { FORK_SPACES_PROTOCOL_VERSION } from "../shared/version.ts";

/** What this server advertises. Phase 0 ships the overlay empty, so no capability is on yet. */
export const serverForkCapabilities: ForkCapabilities = {
  protocolVersion: FORK_SPACES_PROTOCOL_VERSION,
  capabilities: [],
};
