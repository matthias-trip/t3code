import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  EnvironmentAuthorizationError,
  RpcScopeAuthorization,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { ForkCapabilities } from "./capabilities.ts";
import {
  SpaceCommand,
  SpaceCommandRejectedError,
  SpaceDispatchResult,
  SpaceServiceError,
  SpacesSnapshot,
  SpacesStreamItem,
} from "./space.ts";

export const FORK_WS_METHODS = {
  capabilities: "fork.capabilities",
  spacesDispatch: "fork.spaces.dispatch",
  spacesSnapshot: "fork.spaces.snapshot",
  spacesSubscribe: "fork.spaces.subscribe",
} as const;

export const ForkCapabilitiesRpc = Rpc.make(FORK_WS_METHODS.capabilities, {
  payload: Schema.Struct({}),
  success: ForkCapabilities,
  error: EnvironmentAuthorizationError,
});

const ForkSpacesDispatchRpc = Rpc.make(FORK_WS_METHODS.spacesDispatch, {
  payload: SpaceCommand,
  success: SpaceDispatchResult,
  error: Schema.Union([
    SpaceCommandRejectedError,
    SpaceServiceError,
    EnvironmentAuthorizationError,
  ]),
});

const ForkSpacesSnapshotRpc = Rpc.make(FORK_WS_METHODS.spacesSnapshot, {
  payload: Schema.Struct({}),
  success: SpacesSnapshot,
  error: Schema.Union([SpaceServiceError, EnvironmentAuthorizationError]),
});

const ForkSpacesSubscribeRpc = Rpc.make(FORK_WS_METHODS.spacesSubscribe, {
  payload: Schema.Struct({}),
  success: SpacesStreamItem,
  error: Schema.Union([SpaceServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

/**
 * Fork-owned methods, served on the environment WebSocket beside `WsRpcGroup`. Contracts can't
 * import this package, so the server and the client protocol each merge it in.
 */
export const ForkRpcGroup = RpcGroup.make(
  ForkCapabilitiesRpc,
  ForkSpacesDispatchRpc,
  ForkSpacesSnapshotRpc,
  ForkSpacesSubscribeRpc,
).middleware(RpcScopeAuthorization);

export type ForkRpcMethod = RpcGroup.Rpcs<typeof ForkRpcGroup>["_tag"];

export const FORK_RPC_REQUIRED_SCOPES = {
  [FORK_WS_METHODS.capabilities]: AuthOrchestrationReadScope,
  [FORK_WS_METHODS.spacesDispatch]: AuthOrchestrationOperateScope,
  [FORK_WS_METHODS.spacesSnapshot]: AuthOrchestrationReadScope,
  [FORK_WS_METHODS.spacesSubscribe]: AuthOrchestrationReadScope,
} as const satisfies Readonly<Record<ForkRpcMethod, AuthEnvironmentScope>>;
