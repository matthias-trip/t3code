import {
  fixtureSpaceIds,
  fixtureThreadIds,
} from "../../packages/fork-spaces/src/shared/spaceFixtures.ts";
import type { Expect } from "./grade.ts";

/**
 * One user turn in a thread of the fixture world (`spaceFixtures.ts`: "Payments retry redesign"
 * pinned, "Onboarding v3", archived "Q3 cleanup"). `guard` cases are space work the tools must
 * make easy; `control` cases are ordinary work where the agent must leave spaces alone.
 */
export type Case = {
  readonly id: string;
  readonly kind: "guard" | "control";
  readonly source: string;
  /** The calling thread. */
  readonly threadId: string;
  readonly prompt: string;
  readonly expect: Expect;
};

const design = "Spaces proposal §3 and §11: agents can do in a space what a person can";
const noSpaceTools = ["space_*"];
const noSpaceWrites = ["space_create", "space_update", "space_move_thread"];

export const cases: ReadonlyArray<Case> = [
  {
    id: "move-this-thread",
    kind: "guard",
    source: design,
    threadId: fixtureThreadIds.unfiled,
    prompt: "Put this thread in the payments retry space.",
    expect: {
      calls: [{ tool: "space_move_thread", args: { spaceId: fixtureSpaceIds.payments } }],
      threadSpace: "payments retry",
    },
  },
  {
    id: "which-space-am-i-in",
    kind: "guard",
    source: design,
    threadId: fixtureThreadIds.backoff,
    prompt: "Which space is this thread in, and what does its brief say we ship behind?",
    expect: { calls: [{ tool: "space_read" }], callsMustNot: noSpaceWrites },
  },
  {
    id: "which-space-unfiled",
    kind: "guard",
    source: design,
    threadId: fixtureThreadIds.unfiled,
    prompt: "Which space am I in?",
    expect: { calls: [{ tool: "space_read" }], callsMustNot: noSpaceWrites, threadSpace: null },
  },
  {
    id: "move-named-thread",
    kind: "guard",
    source: design,
    threadId: fixtureThreadIds.unfiled,
    prompt: `Move thread ${fixtureThreadIds.banner} into the onboarding v3 space.`,
    expect: {
      calls: [
        {
          tool: "space_move_thread",
          args: { threadId: fixtureThreadIds.banner, spaceId: fixtureSpaceIds.onboarding },
        },
      ],
      threadSpace: null,
    },
  },
  {
    // The archived space refuses threads; the agent should say so, not retry or work around it.
    id: "move-into-archived",
    kind: "guard",
    source: design,
    threadId: fixtureThreadIds.unfiled,
    prompt: "Put this thread in the Q3 cleanup space.",
    expect: {
      maxCalls: { space_move_thread: 1 },
      callsMustNot: ["space_create", "space_update"],
      threadSpace: null,
      finalIncludes: ["archived"],
    },
  },
  {
    id: "create-and-move",
    kind: "guard",
    source: design,
    threadId: fixtureThreadIds.unfiled,
    prompt:
      "Start a new space called Billing export for the CSV export work, and put this thread in it.",
    expect: {
      calls: [{ tool: "space_create", args: { title: "~billing export" } }],
      threadSpace: "billing export",
    },
  },
  {
    id: "pin-space",
    kind: "guard",
    source: design,
    threadId: fixtureThreadIds.unfiled,
    prompt: "Pin the onboarding v3 space.",
    expect: {
      calls: [
        { tool: "space_update", args: { spaceId: fixtureSpaceIds.onboarding, pinned: true } },
      ],
      space: { id: fixtureSpaceIds.onboarding, pinned: true, title: "Onboarding v3" },
    },
  },
  {
    // `brief` replaces the whole brief, so the agent must read it first to keep the rest.
    id: "amend-brief-keeps-rest",
    kind: "guard",
    source: design,
    threadId: fixtureThreadIds.backoff,
    prompt: "Update our space's brief: we now ship behind `pay_retry_v3`, not v2.",
    expect: {
      calls: [{ tool: "space_update", args: { spaceId: fixtureSpaceIds.payments } }],
      space: {
        id: fixtureSpaceIds.payments,
        briefIncludes: ["pay_retry_v3", "SQS FIFO"],
        briefExcludes: ["pay_retry_v2"],
      },
    },
  },
  {
    id: "leave-space",
    kind: "guard",
    source: design,
    threadId: fixtureThreadIds.banner,
    prompt: "Take this thread out of its space; it is unrelated work.",
    expect: {
      calls: [{ tool: "space_move_thread", args: { spaceId: null } }],
      threadSpace: null,
    },
  },
  {
    id: "list-including-archived",
    kind: "guard",
    source: design,
    threadId: fixtureThreadIds.unfiled,
    prompt: "List all my spaces, archived ones too.",
    expect: {
      calls: [{ tool: "space_list", args: { includeArchived: true } }],
      callsMustNot: noSpaceWrites,
    },
  },
  {
    id: "control-rename-thread",
    kind: "control",
    source: "Thread titles are thread metadata, not spaces",
    threadId: fixtureThreadIds.backoff,
    prompt: "Rename this thread to Retry backoff.",
    expect: { callsMustNot: noSpaceTools },
  },
  {
    id: "control-concept-question",
    kind: "control",
    source: "Ordinary question in a thread that is in a space",
    threadId: fixtureThreadIds.backoff,
    prompt: "In two sentences: what is exponential backoff with jitter?",
    expect: { callsMustNot: noSpaceTools },
  },
  {
    id: "control-list-projects",
    kind: "control",
    source: "Projects and spaces both group work; project questions use project tools",
    threadId: fixtureThreadIds.unfiled,
    prompt: "Which projects are registered in T3 Code?",
    expect: { callsMustNot: noSpaceTools },
  },
];
