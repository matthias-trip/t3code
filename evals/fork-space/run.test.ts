import { describe, expect, it } from "vite-plus/test";
import { grade, type SpaceState } from "./grade.ts";

const state: SpaceState = {
  spaces: [
    {
      id: "space:a",
      title: "Payments retry",
      brief: "Ship behind flag_v3. Use SQS.",
      pinnedAt: null,
    },
    { id: "space:b", title: "Onboarding", brief: "", pinnedAt: "2026-11-12T00:00:00.000Z" },
  ],
  threadSpaces: [{ threadId: "thread:me", spaceId: "space:a" }],
};
const failures = (
  expect: Parameters<typeof grade>[0]["expect"],
  calls = [] as Array<{ tool: string; input: unknown }>,
) => grade({ expect, calls, state, threadId: "thread:me" });

describe("grade", () => {
  it.each([
    [
      "matching call",
      { calls: [{ tool: "space_list", args: { includeArchived: true } }] },
      [{ tool: "space_list", input: { includeArchived: true } }],
      true,
    ],
    [
      "call with other args",
      { calls: [{ tool: "space_list", args: { includeArchived: true } }] },
      [{ tool: "space_list", input: {} }],
      false,
    ],
    [
      "substring arg",
      { calls: [{ tool: "space_create", args: { title: "~billing" } }] },
      [{ tool: "space_create", input: { title: "Billing export" } }],
      true,
    ],
    [
      "null arg matches null",
      { calls: [{ tool: "space_move_thread", args: { spaceId: null } }] },
      [{ tool: "space_move_thread", input: { spaceId: null } }],
      true,
    ],
    [
      "null arg rejects a value",
      { calls: [{ tool: "space_move_thread", args: { spaceId: null } }] },
      [{ tool: "space_move_thread", input: { spaceId: "space:a" } }],
      false,
    ],
    ["forbidden prefix", { callsMustNot: ["space_*"] }, [{ tool: "space_read", input: {} }], false],
    [
      "forbidden prefix, other tool",
      { callsMustNot: ["space_*"] },
      [{ tool: "t3_thread_update", input: {} }],
      true,
    ],
  ] as const)("%s", (_name, expectation, calls, pass) => {
    expect(failures(expectation, [...calls]).length === 0).toBe(pass);
  });

  it.each([
    ["thread in the named space", { threadSpace: "payments" }, true],
    ["thread in another space", { threadSpace: "onboarding" }, false],
    ["thread expected in none", { threadSpace: null }, false],
    ["pinned as expected", { space: { id: "space:b", pinned: true } }, true],
    [
      "brief kept and amended",
      { space: { id: "space:a", briefIncludes: ["flag_v3", "sqs"] } },
      true,
    ],
    ["brief lost text", { space: { id: "space:a", briefIncludes: ["fifo"] } }, false],
    ["space gone", { space: { id: "space:c" } }, false],
  ] as const)("state: %s", (_name, expectation, pass) => {
    expect(failures(expectation).length === 0).toBe(pass);
  });
});
