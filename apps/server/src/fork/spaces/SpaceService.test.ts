import { assert, describe, it } from "@effect/vitest";
import {
  fixtureCommandId,
  fixtureSpaceIds,
  fixtureSpacesSnapshot,
  fixtureThreadIds,
} from "@t3tools/fork-spaces/shared/spaceFixtures";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as SpaceService from "./SpaceService.ts";

describe("SpaceService.layerMemory", () => {
  it.effect("dispatches through the shared decider and streams a snapshot, then events", () =>
    Effect.gen(function* () {
      const spaces = yield* SpaceService.SpaceService;
      // Pulling the snapshot proves the subscription is live before the dispatch.
      const pull = yield* Stream.toPull(spaces.subscribe);
      const [first] = yield* pull;
      assert.strictEqual(first.type, "snapshot");
      const result = yield* spaces.dispatch({
        type: "thread.space.set",
        commandId: fixtureCommandId("move"),
        threadId: fixtureThreadIds.unfiled,
        spaceId: fixtureSpaceIds.onboarding,
      });
      const [second] = yield* pull;
      assert.deepStrictEqual(second, {
        type: "event",
        sequence: result.sequence,
        event: {
          type: "thread.space-updated",
          threadId: fixtureThreadIds.unfiled,
          spaceId: fixtureSpaceIds.onboarding,
          previousSpaceId: null,
        },
      });
      const space = yield* spaces.spaceForThread(fixtureThreadIds.unfiled);
      assert.strictEqual(Option.getOrThrow(space).id, fixtureSpaceIds.onboarding);
      const listed = yield* spaces.listSpaces();
      assert.deepStrictEqual(
        listed.map((s) => s.id),
        [fixtureSpaceIds.payments, fixtureSpaceIds.onboarding],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(SpaceService.layerMemory({ initial: fixtureSpacesSnapshot })),
    ),
  );

  it.effect("rejects a thread it is told is missing", () =>
    Effect.gen(function* () {
      const spaces = yield* SpaceService.SpaceService;
      const failure = yield* spaces
        .dispatch({
          type: "thread.space.set",
          commandId: fixtureCommandId("missing"),
          threadId: fixtureThreadIds.unfiled,
          spaceId: fixtureSpaceIds.payments,
        })
        .pipe(Effect.flip);
      assert.strictEqual(
        failure._tag === "SpaceCommandRejectedError" && failure.reason,
        "thread_not_found",
      );
    }).pipe(
      Effect.provide(
        SpaceService.layerMemory({
          initial: fixtureSpacesSnapshot,
          missingThreadIds: [fixtureThreadIds.unfiled],
        }),
      ),
    ),
  );
});
