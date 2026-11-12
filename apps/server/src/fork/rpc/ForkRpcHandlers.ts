import { FORK_WS_METHODS, ForkRpcGroup } from "@t3tools/fork-spaces/contracts/rpc";
import { serverForkCapabilities } from "@t3tools/fork-spaces/server/capabilities";
import * as Effect from "effect/Effect";

import { RpcInstrumentation } from "../../observability/RpcInstrumentation.ts";

// Middleware added later wraps middleware added earlier, so instrumentation wraps authorization.
export const ServerForkRpcGroup = ForkRpcGroup.middleware(RpcInstrumentation);

export const ForkRpcHandlers = ServerForkRpcGroup.toLayer({
  [FORK_WS_METHODS.capabilities]: () => Effect.succeed(serverForkCapabilities),
});
