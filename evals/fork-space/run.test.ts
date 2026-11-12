import { describe, expect, it } from "vite-plus/test";
import { compareToBaseline, grade, needsTiebreak, type SpaceState } from "./grade.ts";

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
  final = "",
) => grade({ expect, calls, state, threadId: "thread:me", final });

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
    ["brief dropped old text", { space: { id: "space:a", briefExcludes: ["flag_v2"] } }, true],
    ["brief kept old text", { space: { id: "space:a", briefExcludes: ["FLAG_V3"] } }, false],
    ["space gone", { space: { id: "space:c" } }, false],
  ] as const)("state: %s", (_name, expectation, pass) => {
    expect(failures(expectation).length === 0).toBe(pass);
  });

  it.each([
    ["one refused call", 1, true],
    ["a retried refused call", 2, false],
  ] as const)("max calls: %s", (_name, count, pass) => {
    const calls = Array.from({ length: count }, () => ({
      tool: "space_move_thread",
      input: { spaceId: "space:a" },
    }));
    expect(failures({ maxCalls: { space_move_thread: 1 } }, calls).length === 0).toBe(pass);
  });

  it.each([
    ["answer names the refusal", "That space is Archived.", true],
    ["answer hides it", "Done!", false],
  ] as const)("final answer: %s", (_name, final, pass) => {
    expect(failures({ finalIncludes: ["archived"] }, [], final).length === 0).toBe(pass);
  });
});

describe("needsTiebreak", () => {
  it.each([
    [1, 2, true],
    [2, 4, true],
    [3, 4, false],
    [1, 3, false],
    [0, 0, false],
  ] as const)("%i of %i passing: %s", (passes, samples, want) => {
    expect(needsTiebreak(passes, samples)).toBe(want);
  });
});

describe("compareToBaseline", () => {
  it.each([
    [{ passes: 2, samples: 2 }, { passes: 0, samples: 0 }, "new"],
    [{ passes: 2, samples: 3 }, { passes: 1, samples: 3 }, "fixed"],
    [{ passes: 1, samples: 2 }, { passes: 2, samples: 2 }, "regressed"],
    [{ passes: 3, samples: 3 }, { passes: 2, samples: 3 }, "same"],
  ] as const)("%o against %o is %s", (now, before, want) => {
    expect(compareToBaseline(now, before)).toBe(want);
  });
});
