import {
  isCompactionCommandMessage,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type ProviderThreadId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  byteLength,
  ENTRY_CLOSE,
  ENVELOPE_CLOSE,
  ENVELOPE_OPEN,
  entryOpen,
  escapeText,
  fitWithinBytes,
  withEntries,
} from "./contextBlock.ts";
import * as SpaceContextContributor from "./SpaceContextContributor.ts";

/**
 * One source of fork context for a turn (the space brief now; later the sources manifest,
 * change deltas and excerpts). Returns plain text for one envelope entry; escaping, the budget,
 * timeouts and failures are handled by the caller.
 */
interface ForkTurnContextContributor {
  /** The entry's `kind` attribute. A fixed lowercase word chosen in code, never user text. */
  readonly kind: string;
  /** Names what a cut shortens in the marker, e.g. "brief". */
  readonly shortenedLabel: string;
  /** May fail with any tagged service error; the caller logs it and skips the contributor. */
  readonly contribute: (input: {
    readonly threadId: ThreadId;
    readonly budgetBytes: number;
  }) => Effect.Effect<
    Option.Option<{
      readonly attributes?: ReadonlyArray<readonly [name: string, value: string]>;
      readonly text: string;
    }>,
    { readonly _tag: string }
  >;
}

/** What turn start knows before the provider thread is loaded. */
interface PrepareInput {
  readonly threadId: ThreadId;
  /** The stored user message, before composer projection. */
  readonly message: { readonly text: string };
  /** The app's provider thread row; a new one means a provider switch. */
  readonly providerThreadId: ProviderThreadId;
  /** The turn start projection; only the fields read here. */
  readonly projection: {
    readonly runs: ReadonlyArray<
      Pick<OrchestrationV2Run, "id" | "providerThreadId" | "userMessageId">
    >;
    readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>;
    readonly providerTurns: ReadonlyArray<
      Pick<OrchestrationV2ProviderTurn, "id" | "providerThreadId" | "runAttemptId" | "ordinal">
    >;
    readonly messages: ReadonlyArray<
      { readonly id: string } & Parameters<typeof isCompactionCommandMessage>[0]
    >;
  };
}

/** One turn's fork context, built before the handoff budget and sent once the run starts. */
export interface ForkTurnPlan {
  /** The text with the block, for the handoff budget: the most this turn can send. */
  readonly withBlock: (text: string) => string;
  /**
   * The text to send: with the block when the provider thread may not have it, else unchanged.
   * Records the send. A record whose turn never reached the provider is ignored next turn.
   */
  readonly textForTurn: (
    text: string,
    facts: { readonly nativeThreadHasTurns: boolean },
  ) => Effect.Effect<string>;
}

const noPlan: ForkTurnPlan = {
  withBlock: (text) => text,
  textForTurn: (text) => Effect.succeed(text),
};

/**
 * Fork context for provider turns. The default adds nothing, so turn start works unchanged
 * where the fork layer is not provided. Never fails: a contributor that fails or times out is
 * skipped with a warning.
 */
export class ForkTurnContext extends Context.Reference<{
  readonly prepare: (input: PrepareInput) => Effect.Effect<ForkTurnPlan>;
}>("t3/fork/context/ForkTurnContext", {
  defaultValue: () => ({ prepare: () => Effect.succeed(noPlan) }),
}) {}

/**
 * Bytes (UTF-8) for the whole block, envelope included. About 1k tokens. The brief editor can
 * show this limit: the space entry's framing takes a few hundred bytes of it.
 */
const DEFAULT_BUDGET_BYTES = 4096;
const CONTRIBUTOR_TIMEOUT = Duration.millis(500);
const MAX_LOGGED_NAME = 64;

/** What the fork last sent on a thread, to resend only when the provider may lack it. */
interface SentRecord {
  readonly fingerprint: string;
  readonly providerThreadId: ProviderThreadId;
  readonly compactionTurnId: string | null;
  /** The provider turn ordinal the send would get; no turn reaching it means it never arrived. */
  readonly providerTurnOrdinal: number;
}

// Two FNV-1a passes (forward, backward): 64 bits keep a stale match out of reach.
const fingerprintOf = (block: string) => {
  let forward = 0x811c9dc5;
  let backward = 0x811c9dc5;
  for (let index = 0; index < block.length; index += 1) {
    forward = Math.imul(forward ^ block.charCodeAt(index), 0x01000193) >>> 0;
    backward = Math.imul(backward ^ block.charCodeAt(block.length - 1 - index), 0x01000193) >>> 0;
  }
  return `${forward.toString(16)}:${backward.toString(16)}:${block.length}`;
};

const providerThreadFacts = (input: PrepareInput) => {
  const { projection, providerThreadId } = input;
  const turns = projection.providerTurns.filter(
    (turn) => turn.providerThreadId === providerThreadId,
  );
  const compactionRunIds = new Set(
    projection.runs
      .filter(
        (run) =>
          run.providerThreadId === providerThreadId &&
          projection.messages.some(
            (message) => message.id === run.userMessageId && isCompactionCommandMessage(message),
          ),
      )
      .map((run) => run.id),
  );
  const compactionAttemptIds = new Set(
    projection.attempts
      .filter((attempt) => compactionRunIds.has(attempt.runId))
      .map((attempt) => attempt.id),
  );
  const compactionTurn = turns
    .filter((turn) => turn.runAttemptId !== null && compactionAttemptIds.has(turn.runAttemptId))
    .toSorted((a, b) => a.ordinal - b.ordinal)
    .at(-1);
  return {
    lastTurnOrdinal: Math.max(0, ...turns.map((turn) => turn.ordinal)),
    compactionTurnId: compactionTurn?.id ?? null,
  };
};

const errorName = (name: string) => name.slice(0, MAX_LOGGED_NAME);

/**
 * Runs contributors in order. Each gets the budget left after the earlier ones; its escaped
 * text is cut to fit. The block goes to the provider when its thread may lack it: no turns yet
 * (first turn, provider switch, resume fallback), a compaction since the last send, changed
 * content (another space, an edited brief), or no record of a send (server restart). Slash
 * commands, `/compact` and native goal commands among them, go verbatim.
 */
export const makeForkTurnContext = (
  contributors: ReadonlyArray<ForkTurnContextContributor>,
  options?: { readonly budgetBytes?: number },
) => {
  const sent = new Map<ThreadId, SentRecord>();

  const renderEntries = Effect.fn("ForkTurnContext.renderEntries")(function* (threadId: ThreadId) {
    let remaining =
      (options?.budgetBytes ?? DEFAULT_BUDGET_BYTES) - byteLength(ENVELOPE_OPEN + ENVELOPE_CLOSE);
    const entries: Array<string> = [];
    for (const contributor of contributors) {
      const separator = entries.length === 0 ? "" : "\n";
      const frame = byteLength(separator + entryOpen(contributor) + ENTRY_CLOSE);
      if (remaining - frame <= 0) break;
      // Failures, defects and timeouts skip the contributor; interruption still ends the turn.
      const skip = (failure: "error" | "defect" | "timeout", name?: string) =>
        Effect.logWarning("Fork turn context contributor failed; skipping it", {
          threadId,
          contributor: contributor.kind,
          failure,
          ...(name === undefined ? {} : { name: errorName(name) }),
        }).pipe(Effect.as(Option.none()));
      const contribution = yield* contributor
        .contribute({ threadId, budgetBytes: remaining - frame })
        .pipe(
          Effect.catch((error) => skip("error", error._tag)),
          Effect.catchDefect((defect) =>
            skip("defect", defect instanceof Error ? defect.constructor.name : typeof defect),
          ),
          Effect.timeoutOrElse({ duration: CONTRIBUTOR_TIMEOUT, orElse: () => skip("timeout") }),
        );
      if (Option.isNone(contribution) || contribution.value.text.trim() === "") continue;
      const open = separator + entryOpen({ ...contributor, ...contribution.value });
      const text = fitWithinBytes(
        escapeText(contribution.value.text.trimEnd()),
        remaining - byteLength(open + ENTRY_CLOSE),
        contributor.shortenedLabel,
      );
      if (text === null) continue;
      const entry = `${open}${text}${ENTRY_CLOSE}`;
      entries.push(entry);
      remaining -= byteLength(entry);
    }
    return entries.join("");
  });

  return ForkTurnContext.of({
    prepare: Effect.fn("ForkTurnContext.prepare")(function* (input: PrepareInput) {
      // Providers parse slash commands from the raw text; context would change the command.
      if (input.message.text.trimStart().startsWith("/")) return noPlan;
      const entries = yield* renderEntries(input.threadId);
      if (entries === "") {
        sent.delete(input.threadId);
        return noPlan;
      }
      const withBlock = (text: string) =>
        withEntries({ rawText: input.message.text, text, entries });
      const facts = providerThreadFacts(input);
      const record: SentRecord = {
        fingerprint: fingerprintOf(entries),
        providerThreadId: input.providerThreadId,
        compactionTurnId: facts.compactionTurnId,
        providerTurnOrdinal: facts.lastTurnOrdinal + 1,
      };
      return {
        withBlock,
        textForTurn: (text, { nativeThreadHasTurns }) =>
          Effect.sync(() => {
            const last = sent.get(input.threadId);
            const providerHasIt =
              nativeThreadHasTurns &&
              last !== undefined &&
              last.providerTurnOrdinal <= facts.lastTurnOrdinal &&
              last.providerThreadId === record.providerThreadId &&
              last.compactionTurnId === record.compactionTurnId &&
              last.fingerprint === record.fingerprint;
            if (providerHasIt) return text;
            sent.set(input.threadId, record);
            return withBlock(text);
          }),
      } satisfies ForkTurnPlan;
    }),
  });
};

export const layer = Layer.effect(
  ForkTurnContext,
  Effect.gen(function* () {
    const space = yield* SpaceContextContributor.make;
    return makeForkTurnContext([space]);
  }),
);
