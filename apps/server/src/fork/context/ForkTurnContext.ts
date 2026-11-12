import type { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { escapeComposerContextPayloadText } from "@t3tools/shared/composerContextReferences";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SpaceContextContributor from "./SpaceContextContributor.ts";

interface ForkTurnContextInput {
  readonly threadId: ThreadId;
  readonly providerKind?: ProviderDriverKind;
  readonly isFirstTurn?: boolean;
}

/**
 * One source of fork context for a turn (the space brief now; later the sources manifest,
 * change deltas and excerpts). Returns plain text for one envelope entry; escaping, the budget
 * and failures are handled by the caller.
 */
interface ForkTurnContextContributor {
  /** The entry's `kind` attribute. A fixed lowercase word chosen in code, never user text. */
  readonly kind: string;
  /** May fail with any tagged service error; the caller logs it and skips the contributor. */
  readonly contribute: (
    input: ForkTurnContextInput & { readonly budgetBytes: number },
  ) => Effect.Effect<Option.Option<string>, { readonly _tag: string }>;
}

/**
 * Fork context appended to every provider turn's prompt. The default contributes nothing, so
 * turn start works unchanged where the fork layer is not provided. Never fails: a contributor
 * that fails is skipped with a warning.
 */
export class ForkTurnContext extends Context.Reference<{
  readonly contribute: (input: ForkTurnContextInput) => Effect.Effect<Option.Option<string>>;
}>("t3/fork/context/ForkTurnContext", {
  defaultValue: () => ({ contribute: () => Effect.succeedNone }),
}) {}

/** Bytes (UTF-8) for the whole block, envelope included. About 1k tokens, sent every turn. */
const DEFAULT_BUDGET_BYTES = 4096;

// The same envelope and entry tags as composer context, so upstream's escaping covers them.
const ENVELOPE_OPEN = '<t3_context version="1">\n';
const ENVELOPE_CLOSE = "\n</t3_context>";
const TRUNCATED_MARKER = "\n[truncated]";

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

/** Longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`, split on a code point. */
function prefixWithinBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = byteLength(char);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

/**
 * Fits escaped text into `maxBytes`. Over budget, it is cut at the last line break (else word
 * break) in the second half of the allowance, never inside an `&lt;` escape, then marked.
 */
function fitWithinBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const prefix = prefixWithinBytes(text, maxBytes - byteLength(TRUNCATED_MARKER));
  const half = prefix.length / 2;
  const lineBreak = prefix.lastIndexOf("\n");
  const wordBreak = prefix.search(/\s\S*$/);
  let cut =
    lineBreak >= half
      ? prefix.slice(0, lineBreak)
      : wordBreak >= half
        ? prefix.slice(0, wordBreak)
        : prefix;
  const ampersand = cut.lastIndexOf("&");
  if (ampersand >= cut.length - 3 && text.startsWith("&lt;", ampersand)) {
    cut = cut.slice(0, ampersand);
  }
  return `${cut.trimEnd()}${TRUNCATED_MARKER}`;
}

/**
 * Runs contributors in order. Each gets the budget left after the earlier ones; its escaped
 * text is cut to fit. Returns one `<t3_context>` block, or none when nothing contributed.
 */
export const makeForkTurnContext = (
  contributors: ReadonlyArray<ForkTurnContextContributor>,
  options?: { readonly budgetBytes?: number },
) =>
  ForkTurnContext.of({
    contribute: Effect.fn("ForkTurnContext.contribute")(function* (input: ForkTurnContextInput) {
      let remaining =
        (options?.budgetBytes ?? DEFAULT_BUDGET_BYTES) - byteLength(ENVELOPE_OPEN + ENVELOPE_CLOSE);
      const entries: Array<string> = [];
      for (const contributor of contributors) {
        const open = `${entries.length === 0 ? "" : "\n"}<context kind="${contributor.kind}">\n`;
        const close = "\n</context>";
        const budgetBytes = remaining - byteLength(open + close);
        if (budgetBytes <= byteLength(TRUNCATED_MARKER)) break;
        // Failures and defects skip the contributor; interruption still ends the turn.
        const skip = (failure: "error" | "defect") =>
          Effect.logWarning("Fork turn context contributor failed; skipping it", {
            threadId: input.threadId,
            contributor: contributor.kind,
            failure,
          }).pipe(Effect.as(Option.none<string>()));
        const text = yield* contributor.contribute({ ...input, budgetBytes }).pipe(
          Effect.catch(() => skip("error")),
          Effect.catchDefect(() => skip("defect")),
        );
        if (Option.isNone(text) || text.value.trim() === "") continue;
        const entry = `${open}${fitWithinBytes(
          escapeComposerContextPayloadText(text.value.trimEnd()),
          budgetBytes,
        )}${close}`;
        entries.push(entry);
        remaining -= byteLength(entry);
      }
      if (entries.length === 0) return Option.none<string>();
      return Option.some(`${ENVELOPE_OPEN}${entries.join("")}${ENVELOPE_CLOSE}`);
    }),
  });

export const layer = Layer.effect(
  ForkTurnContext,
  Effect.gen(function* () {
    const space = yield* SpaceContextContributor.make;
    return makeForkTurnContext([space]);
  }),
);
