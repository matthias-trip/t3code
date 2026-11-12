import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";

import { SpaceId, type Space, type SpacesSnapshot } from "../contracts/space.ts";

/** Sample data for tests and UI work against fixtures. Not used at runtime. */
export const fixtureProjectIds = {
  payments: ProjectId.make("project:payments-service"),
  checkout: ProjectId.make("project:checkout-web"),
  infra: ProjectId.make("project:infra"),
} as const;

export const fixtureThreadIds = {
  backoff: ThreadId.make("thread:add-retry-backoff"),
  idempotency: ThreadId.make("thread:idempotency-key-audit"),
  banner: ThreadId.make("thread:retry-status-banner"),
  onboardingCopy: ThreadId.make("thread:onboarding-copy"),
  unfiled: ThreadId.make("thread:unfiled"),
} as const;

export const fixtureSpaceIds = {
  payments: SpaceId.make("space:payments-retry"),
  onboarding: SpaceId.make("space:onboarding-v3"),
  archived: SpaceId.make("space:q3-cleanup"),
} as const;

const fixtureSpaces = {
  payments: {
    id: fixtureSpaceIds.payments,
    title: "Payments retry redesign",
    brief:
      "Replace the cron retry with event-driven retries on SQS FIFO. Keep idempotency keys end-to-end. Ship behind `pay_retry_v2`.",
    icon: { kind: "monogram", text: "PR", color: "indigo" },
    projectIds: [fixtureProjectIds.payments, fixtureProjectIds.checkout, fixtureProjectIds.infra],
    defaults: {},
    pinnedAt: "2026-11-10T09:00:00.000Z",
    archivedAt: null,
    createdAt: "2026-11-01T09:00:00.000Z",
    updatedAt: "2026-11-11T16:30:00.000Z",
  },
  onboarding: {
    id: fixtureSpaceIds.onboarding,
    title: "Onboarding v3",
    brief: "",
    icon: null,
    projectIds: [fixtureProjectIds.checkout],
    defaults: { threadEnvMode: "worktree" },
    pinnedAt: null,
    archivedAt: null,
    createdAt: "2026-11-05T09:00:00.000Z",
    updatedAt: "2026-11-05T09:00:00.000Z",
  },
  archived: {
    id: fixtureSpaceIds.archived,
    title: "Q3 cleanup",
    brief: "Done.",
    icon: null,
    projectIds: [],
    defaults: {},
    pinnedAt: null,
    archivedAt: "2026-10-01T09:00:00.000Z",
    createdAt: "2026-07-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
  },
} as const satisfies Record<string, Space>;

export const fixtureSpacesSnapshot: SpacesSnapshot = {
  sequence: 12,
  spaces: Object.values(fixtureSpaces),
  threadSpaces: [
    { threadId: fixtureThreadIds.backoff, spaceId: fixtureSpaceIds.payments },
    { threadId: fixtureThreadIds.idempotency, spaceId: fixtureSpaceIds.payments },
    { threadId: fixtureThreadIds.banner, spaceId: fixtureSpaceIds.payments },
    { threadId: fixtureThreadIds.onboardingCopy, spaceId: fixtureSpaceIds.onboarding },
  ],
};

/** A command id for tests that dispatch; pass a name unique within the test. */
export const fixtureCommandId = (name: string) => CommandId.make(`command:fixture:${name}`);
