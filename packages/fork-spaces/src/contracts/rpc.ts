import {
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  EnvironmentAuthorizationError,
  RpcScopeAuthorization,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { ForkCapabilities } from "./capabilities.ts";

export const FORK_WS_METHODS = {
  capabilities: "fork.capabilities",
} as const;

export const ForkCapabilitiesRpc = Rpc.make(FORK_WS_METHODS.capabilities, {
  payload: Schema.Struct({}),
  success: ForkCapabilities,
  error: EnvironmentAuthorizationError,
});

/**
 * Fork-owned methods, served on the environment WebSocket beside `WsRpcGroup`. Contracts can't
 * import this package, so the server and the client protocol each merge it in.
 */
export const ForkRpcGroup = RpcGroup.make(ForkCapabilitiesRpc).middleware(RpcScopeAuthorization);

export type ForkRpcMethod = RpcGroup.Rpcs<typeof ForkRpcGroup>["_tag"];

export const FORK_RPC_REQUIRED_SCOPES = {
  [FORK_WS_METHODS.capabilities]: AuthOrchestrationReadScope,
} as const satisfies Readonly<Record<ForkRpcMethod, AuthEnvironmentScope>>;
