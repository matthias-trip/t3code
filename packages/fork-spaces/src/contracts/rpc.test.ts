import { WsRpcGroup } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  FORK_RPC_REQUIRED_SCOPES,
  FORK_WS_METHODS,
  ForkCapabilitiesRpc,
  ForkRpcGroup,
} from "./rpc.ts";

describe("ForkRpcGroup", () => {
  it("uses fork.* tags that never collide with upstream methods", () => {
    for (const tag of ForkRpcGroup.requests.keys()) {
      expect(tag.startsWith("fork.")).toBe(true);
      expect(WsRpcGroup.requests.has(tag)).toBe(false);
    }
  });

  it("declares a scope for every fork method", () => {
    expect(new Set(Object.keys(FORK_RPC_REQUIRED_SCOPES))).toEqual(
      new Set(ForkRpcGroup.requests.keys()),
    );
  });

  it("keeps known capabilities when a newer server sends unknown ones", () => {
    const decode = Schema.decodeUnknownSync(Schema.toCodecJson(ForkCapabilitiesRpc.successSchema));
    expect(decode({ protocolVersion: 3, capabilities: ["teleport", "sources"] })).toEqual({
      protocolVersion: 3,
      capabilities: ["sources"],
    });
    expect(FORK_WS_METHODS.capabilities).toBe("fork.capabilities");
  });
});
