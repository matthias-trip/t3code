import { AuthOrchestrationReadScope, AuthTerminalReadScope } from "@t3tools/contracts";
import { FORK_WS_METHODS } from "@t3tools/fork-spaces/contracts/rpc";
import { serverForkCapabilities } from "@t3tools/fork-spaces/server/capabilities";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Tracer from "effect/Tracer";

import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import { rpcInstrumentationLayer } from "../../observability/RpcInstrumentation.ts";
import { ForkRpcHandlers, ServerForkRpcGroup } from "./ForkRpcHandlers.ts";

const makeClient = (scopes: Parameters<typeof RpcAuthorization.layer>[0]) =>
  RpcTest.makeClient(ServerForkRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(ForkRpcHandlers, RpcAuthorization.layer(scopes), rpcInstrumentationLayer),
    ),
  );

const recordSpans = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const aggregateOf = (name: string) =>
    spans.find((span) => span.name === name)?.attributes.get("rpc.aggregate");
  return { tracer, aggregateOf };
};

describe("ForkRpcHandlers", () => {
  it.effect("answers fork.capabilities with what this server advertises", () =>
    Effect.gen(function* () {
      const { tracer, aggregateOf } = recordSpans();
      const client = yield* makeClient([AuthOrchestrationReadScope]);
      expect(
        yield* client[FORK_WS_METHODS.capabilities]({}).pipe(Effect.withTracer(tracer)),
      ).toEqual(serverForkCapabilities);
      expect(aggregateOf(`ws.rpc.${FORK_WS_METHODS.capabilities}`)).toBe("fork");
    }).pipe(Effect.scoped),
  );

  it.effect("requires orchestration read scope", () =>
    Effect.gen(function* () {
      const { tracer, aggregateOf } = recordSpans();
      const client = yield* makeClient([AuthTerminalReadScope]);
      expect(
        yield* client[FORK_WS_METHODS.capabilities]({}).pipe(
          Effect.flip,
          Effect.withTracer(tracer),
        ),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthOrchestrationReadScope,
      });
      expect(aggregateOf(`ws.rpc.${FORK_WS_METHODS.capabilities}`)).toBe("fork");
    }).pipe(Effect.scoped),
  );
});
