import { WsRpcGroup } from "@t3tools/contracts";
import { ForkRpcGroup } from "@t3tools/fork-spaces/contracts/rpc"; // fork-seam
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/rpc";

// fork-seam: the fork RPC group shares the environment socket; upstream servers reject its tags.
export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup.merge(ForkRpcGroup));
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

// Pings go out every 5 seconds, and a server busy for a few seconds stops
// answering them. Allow 15 seconds without any frame before dropping the socket.
export const PING_TIMEOUT = "15 seconds";
