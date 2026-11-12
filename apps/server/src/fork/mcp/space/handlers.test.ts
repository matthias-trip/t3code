import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { SpaceId } from "@t3tools/fork-spaces/contracts/space";
import {
  fixtureProjectIds,
  fixtureSpaceIds,
  fixtureSpacesSnapshot,
  fixtureThreadIds,
} from "@t3tools/fork-spaces/shared/spaceFixtures";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { liveThreadsLayer } from "../../../mcp/McpToolAccess.testkit.ts";
import * as SpaceService from "../../spaces/SpaceService.ts";
import * as SpaceHandlers from "./handlers.ts";
import { SpaceToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:spaces");
const missingThread = ThreadId.make("thread:missing");

// "spaces" joins McpCapability with the integration seam; until then the set is cast.
const capabilities = (names: ReadonlyArray<string>) =>
  new Set(names) as McpInvocationContext.McpInvocationScope["capabilities"];

const threadScope = (
  threadId: ThreadId,
  granted: ReadonlyArray<string> = ["orchestration", "spaces"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: capabilities(granted),
  issuedAt: 0,
});

const clientScope = (
  access: "read-only" | "full-access",
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "client:outside",
  thread: undefined,
  client: { sessionId: "outside", label: "Outside", access },
  capabilities: capabilities(["orchestration", "spaces"]),
  issuedAt: 0,
});

const inBackoff = threadScope(fixtureThreadIds.backoff);
const unfiled = threadScope(fixtureThreadIds.unfiled);

const call = (
  scope: McpInvocationContext.McpInvocationScope,
  name: keyof (typeof SpaceToolkit)["tools"],
  params: object,
) =>
  Effect.gen(function* () {
    const toolkit = yield* SpaceToolkit;
    const chunks = yield* toolkit
      .handle(name, params as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    const last = chunks.at(-1);
    assert.isDefined(last);
    return last.result as unknown as Record<string, unknown>;
  }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, scope));

const layer = McpToolAccess.HandlersLayer.layer(SpaceHandlers.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      SpaceService.layerMemory({
        initial: fixtureSpacesSnapshot,
        missingThreadIds: [missingThread],
      }),
      liveThreadsLayer,
      SecureRandom.layerWebCrypto,
    ),
  ),
);

const spaceOf = Effect.fn("spaceOf")(function* (threadId: ThreadId) {
  const spaces = yield* SpaceService.SpaceService;
  return Option.getOrNull(Option.map(yield* spaces.spaceForThread(threadId), (space) => space.id));
});

describe("space MCP tools", () => {
  it.effect("lists active spaces pinned first, and archived ones only when asked", () =>
    Effect.gen(function* () {
      const active = yield* call(unfiled, "space_list", {});
      assert.deepStrictEqual(active, {
        spaces: [
          {
            spaceId: fixtureSpaceIds.payments,
            title: "Payments retry redesign",
            pinned: true,
            archived: false,
          },
          {
            spaceId: fixtureSpaceIds.onboarding,
            title: "Onboarding v3",
            pinned: false,
            archived: false,
          },
        ],
      });
      const all = (yield* call(unfiled, "space_list", { includeArchived: true })) as {
        spaces: ReadonlyArray<{ spaceId: string; archived: boolean }>;
      };
      assert.deepStrictEqual(
        all.spaces.map((space) => [space.spaceId, space.archived]),
        [
          [fixtureSpaceIds.payments, false],
          [fixtureSpaceIds.onboarding, false],
          [fixtureSpaceIds.archived, true],
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads the calling thread's space when no id is given", () =>
    Effect.gen(function* () {
      const own = (yield* call(inBackoff, "space_read", {})) as {
        space: { spaceId: string; brief: string; projectIds: ReadonlyArray<string> };
      };
      assert.strictEqual(own.space.spaceId, fixtureSpaceIds.payments);
      assert.include(own.space.brief, "pay_retry_v2");
      assert.deepStrictEqual(own.space.projectIds, [
        fixtureProjectIds.payments,
        fixtureProjectIds.checkout,
        fixtureProjectIds.infra,
      ]);
      assert.deepStrictEqual(yield* call(unfiled, "space_read", {}), { space: null });
      assert.include(yield* call(clientScope("full-access"), "space_read", {}), {
        code: "target_required",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reports an unknown space as an invalid request", () =>
    Effect.gen(function* () {
      const unknown = SpaceId.make("space:nope");
      for (const result of [
        yield* call(unfiled, "space_read", { spaceId: unknown }),
        yield* call(unfiled, "space_update", { spaceId: unknown, title: "X" }),
        yield* call(unfiled, "space_move_thread", { spaceId: unknown }),
      ]) {
        assert.include(result, { _tag: "OrchestratorMcpFailure", code: "invalid_request" });
        assert.include(String(result.message), "space:nope was not found");
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates a space once per retry key", () =>
    Effect.gen(function* () {
      const create = call(unfiled, "space_create", {
        title: "Billing export",
        brief: "CSV export for finance.",
        projectIds: [fixtureProjectIds.payments],
        clientRequestId: "create-1",
      });
      const first = yield* create;
      const retried = yield* create;
      assert.deepStrictEqual(retried, first);
      const other = yield* call(threadScope(fixtureThreadIds.banner), "space_create", {
        title: "Billing export",
        clientRequestId: "create-1",
      });
      assert.notStrictEqual(other.spaceId, first.spaceId);
      const read = yield* call(unfiled, "space_read", { spaceId: first.spaceId as SpaceId });
      assert.deepStrictEqual(read, {
        space: {
          spaceId: first.spaceId,
          title: "Billing export",
          brief: "CSV export for finance.",
          projectIds: [fixtureProjectIds.payments],
          pinned: false,
          archived: false,
        },
      });
      const listed = (yield* call(unfiled, "space_list", {})) as { spaces: ReadonlyArray<unknown> };
      assert.lengthOf(listed.spaces, 4);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("updates only the fields given", () =>
    Effect.gen(function* () {
      const spaceId = fixtureSpaceIds.onboarding;
      yield* call(unfiled, "space_update", { spaceId, title: "Onboarding v4", pinned: true });
      const read = (yield* call(unfiled, "space_read", { spaceId })) as {
        space: Record<string, unknown>;
      };
      assert.include(read.space, { title: "Onboarding v4", pinned: true, brief: "" });
      yield* call(unfiled, "space_update", { spaceId, brief: "New flow." });
      const again = (yield* call(unfiled, "space_read", { spaceId })) as {
        space: Record<string, unknown>;
      };
      assert.include(again.space, { title: "Onboarding v4", pinned: true, brief: "New flow." });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("moves the calling thread by default, a named thread, and out with null", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* call(unfiled, "space_move_thread", { spaceId: fixtureSpaceIds.onboarding }),
        { threadId: fixtureThreadIds.unfiled, spaceId: fixtureSpaceIds.onboarding },
      );
      assert.strictEqual(yield* spaceOf(fixtureThreadIds.unfiled), fixtureSpaceIds.onboarding);
      yield* call(unfiled, "space_move_thread", {
        threadId: fixtureThreadIds.backoff,
        spaceId: null,
      });
      assert.isNull(yield* spaceOf(fixtureThreadIds.backoff));
      assert.include(
        yield* call(unfiled, "space_move_thread", { spaceId: fixtureSpaceIds.archived }),
        { code: "invalid_request" },
      );
      assert.include(
        yield* call(unfiled, "space_move_thread", {
          threadId: missingThread,
          spaceId: fixtureSpaceIds.payments,
        }),
        { code: "thread_not_found" },
      );
      assert.include(
        yield* call(clientScope("full-access"), "space_move_thread", {
          spaceId: fixtureSpaceIds.payments,
        }),
        { code: "target_required" },
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("repeats a retried move, so a later move is not undone", () =>
    Effect.gen(function* () {
      const intoPayments = call(unfiled, "space_move_thread", {
        spaceId: fixtureSpaceIds.payments,
        clientRequestId: "move-1",
      });
      yield* intoPayments;
      yield* call(unfiled, "space_move_thread", { spaceId: fixtureSpaceIds.onboarding });
      yield* intoPayments;
      assert.strictEqual(yield* spaceOf(fixtureThreadIds.unfiled), fixtureSpaceIds.onboarding);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lets a read-only client read but not write", () =>
    Effect.gen(function* () {
      const readOnly = clientScope("read-only");
      const listed = (yield* call(readOnly, "space_list", {})) as {
        spaces: ReadonlyArray<unknown>;
      };
      assert.lengthOf(listed.spaces, 2);
      for (const result of [
        yield* call(readOnly, "space_create", { title: "Sneaky" }),
        yield* call(readOnly, "space_update", { spaceId: fixtureSpaceIds.payments, pinned: false }),
        yield* call(readOnly, "space_move_thread", {
          threadId: fixtureThreadIds.unfiled,
          spaceId: fixtureSpaceIds.payments,
        }),
      ]) {
        assert.include(result, { code: "capability_denied" });
      }
      const spaces = yield* SpaceService.SpaceService;
      assert.deepStrictEqual(yield* spaces.snapshot, fixtureSpacesSnapshot);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses every tool to a credential without the spaces capability", () =>
    Effect.gen(function* () {
      const without = threadScope(fixtureThreadIds.unfiled, ["orchestration"]);
      for (const result of [
        yield* call(without, "space_list", {}),
        yield* call(without, "space_read", {}),
        yield* call(without, "space_create", { title: "X" }),
        yield* call(without, "space_move_thread", { spaceId: fixtureSpaceIds.payments }),
      ]) {
        assert.include(result, { _tag: "McpCapabilityUnavailableError", capability: "spaces" });
      }
    }).pipe(Effect.provide(layer)),
  );
});
