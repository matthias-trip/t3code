import { AuthOrchestrationReadScope, AuthTerminalReadScope } from "@t3tools/contracts";
import { FORK_WS_METHODS } from "@t3tools/fork-spaces/contracts/rpc";
import { serverForkCapabilities } from "@t3tools/fork-spaces/server/capabilities";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import { rpcInstrumentationLayer } from "../../observability/RpcInstrumentation.ts";
import { ForkRpcHandlers, ServerForkRpcGroup } from "./ForkRpcHandlers.ts";

const makeClient = (scopes: Parameters<typeof RpcAuthorization.layer>[0]) =>
  RpcTest.makeClient(ServerForkRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(ForkRpcHandlers, RpcAuthorization.layer(scopes), rpcInstrumentationLayer),
    ),
  );

describe("ForkRpcHandlers", () => {
  it.effect("answers fork.capabilities with what this server advertises", () =>
    Effect.gen(function* () {
      const client = yield* makeClient([AuthOrchestrationReadScope]);
      expect(yield* client[FORK_WS_METHODS.capabilities]({})).toEqual(serverForkCapabilities);
    }).pipe(Effect.scoped),
  );

  it.effect("requires orchestration read scope", () =>
    Effect.gen(function* () {
      const client = yield* makeClient([AuthTerminalReadScope]);
      expect(yield* client[FORK_WS_METHODS.capabilities]({}).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthOrchestrationReadScope,
      });
    }).pipe(Effect.scoped),
  );
});
