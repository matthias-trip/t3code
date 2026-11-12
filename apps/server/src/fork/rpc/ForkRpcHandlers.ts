import { FORK_WS_METHODS, ForkRpcGroup } from "@t3tools/fork-spaces/contracts/rpc";
import { serverForkCapabilities } from "@t3tools/fork-spaces/server/capabilities";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";

import { RpcInstrumentation } from "../../observability/RpcInstrumentation.ts";

/**
 * Labels fork spans with `rpc.aggregate: "fork"`. RpcInstrumentation looks the aggregate up in
 * the upstream method table, which has no fork methods.
 */
class ForkRpcAggregate extends RpcMiddleware.Service<ForkRpcAggregate>()(
  "t3/server/fork/ForkRpcAggregate",
) {}

const forkRpcAggregateLayer = Layer.succeed(ForkRpcAggregate)((effect) =>
  Effect.annotateCurrentSpan("rpc.aggregate", "fork").pipe(Effect.andThen(effect)),
);

// Middleware added later wraps middleware added earlier: instrumentation opens the span, the
// aggregate label lands on it, then authorization runs, so rejected calls are labelled too.
export const ServerForkRpcGroup =
  ForkRpcGroup.middleware(ForkRpcAggregate).middleware(RpcInstrumentation);

/** Serves the fork RPC group beside `group` on the same socket. */
export const withForkRpcGroup = <Rpcs extends Rpc.Any>(group: RpcGroup.RpcGroup<Rpcs>) =>
  group.merge(ServerForkRpcGroup);

export const ForkRpcHandlers = Layer.merge(
  ServerForkRpcGroup.toLayer({
    [FORK_WS_METHODS.capabilities]: () => Effect.succeed(serverForkCapabilities),
  }),
  forkRpcAggregateLayer,
);
