# P1.E fix brief: `ForkTurnContext` (per-turn space context)

Worktree `~/Workspace/t3code-spaces-wt/p1.e`, branch `task/p1.e-turn-context`. Reviewed head `21b708d967`; unverified WIP on top: `267eaf14fc` (ForkTurnContext.ts, ForkTurnContext.test.ts, SpaceContextContributor.ts, new contextBlock.ts). Review that draft critically, keep what is right, redo the rest. Owned: `apps/server/src/fork/context/**`. The only accepted upstream edit is the one-word `export` of `escapeComposerContextPayloadText` in `packages/shared/src/composerContextReferences.ts` (commit `ed528f8ac4`); any further escaping happens in fork code. Do not edit `ProviderTurnStartService.ts` or `server.ts`: report the seam lines. Read `../agent-ground-rules.md` first.

What it is: `ForkTurnContext.contribute(...)` builds one `<t3_context version="1">` block (space title, projects, brief) within a byte budget (default 4096 bytes). A space contributor uses the frozen `SpaceService`. The orchestrator wires it into `ProviderTurnStartService.ts` (~:834) so every provider gets it in one place.

## Fix list (decisions made)

1. **Send policy (main fix).** Do not append every turn: the block would pile up in the provider's native history (about 1k tokens per turn). Send when any of: (a) the provider-native thread has no turns yet (first turn, provider switch or handoff, resume fallback); (b) a compaction happened on this provider thread since the fork last sent the block; (c) the thread's space, or that space's content (fingerprint of what the block would contain), changed since the last send; (d) the fork has no record of a previous send for this thread (e.g. after a restart). Keep a per-thread "last sent" record (fingerprint, provider thread id, compaction marker) in memory in the fork service. The upstream seam passes only facts already in scope there (native-thread-has-turns, provider thread id, compaction turn items or counter); the decision logic stays in fork code. Replace the unused `isFirstTurn` / `providerKind` inputs. State whether "sent" is recorded when the turn starts or at-least-once.
2. **Seam placement.** Slash-command and native goal-command checks use the raw `message.text` before appending (`RunExecutionService` and `IdleCompaction` compare text to `"/compact"`; goal commands are sent verbatim). Count the block in the `handoffBudget` text (~:1016). Report exact anchors and lines for `ProviderTurnStartService.ts` and for `server.ts`.
3. Timeout each contributor (500 ms), treated as skip("timeout").
4. Truncation: if a cut leaves an odd number of ``` fences, close the fence before the marker; the marker says the brief was shortened. Report the 4096-byte budget so the brief editor can surface the limit.
5. Contributor-failure warning: annotate with the bounded `error._tag` or defect class name only.
6. Log a warning before the ProjectService-failure fallback to project ids.
7. Composition test: real wiring (`ForkTurnContext.layer` + `SpaceService` memory layer) returns Some for a fixture thread, so a missing provide is caught.
8. One envelope: if the message already carries a `<t3_context version="1">` envelope from `projectComposerContextForProvider`, merge the space `<context>` into it (or justify two in 2 lines).
9. Injection: escape every `<` and `&` in contributed text and `"` in attribute values (title). Agents will soon edit briefs through MCP (P1.D), so this is a persistent injection path.
10. Fix the self-comparing budget assertion (`ForkTurnContext.test.ts` ~:173). Add rows: a dying contributor is skipped and the next still runs; an interrupted contributor propagates interruption (`Exit.isInterrupted`).

Policy tests: first turn sends; second turn in the same space skips; brief edited sends; thread moved to another space sends; compaction marker sends; new provider thread sends; fresh service instance (restart) sends once.

## Done when

`vp test run src/fork/context` (apps/server), typecheck apps/server, `vp run check:changed feature/spaces` green. Then a fresh-context reviewer, then merge.
