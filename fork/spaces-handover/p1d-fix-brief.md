# P1.D fix brief: `space_*` MCP tools and evals

Worktree `~/Workspace/t3code-spaces-wt/p1.d`, branch `task/p1.d-mcp`. Reviewed head `be57da996b`; unverified WIP on top: `c0d0990ff8` (handlers.ts, handlers.test.ts, tools.ts, new world.testkit.ts, evals/fork-space/*). Review that draft critically, keep what is right, redo the rest. Owned: `apps/server/src/fork/mcp/space/**`, `evals/fork-space/**`. The Space contract stays unchanged. Read `../agent-ground-rules.md` first.

Backed only by the frozen `SpaceService` (test with `layerMemory`). Tools: `space_list`, `space_read`, `space_create`, `space_update` (title/brief/pin), `space_move_thread`.

## Fix list (decisions made)

1. **Escalation via brief.** `space_update` changing `title` or `brief` requires a full-access caller (runtime mode) with the default interaction mode, and not a linked/fenced caller. Reuse upstream's expression of "full-access" (McpInvocationContext limits, `clientModeCeiling`, `delegatedTaskModes`). Pin/unpin stays a normal write. Same rule for `space_create` with a non-empty brief. Why: a brief is injected into every member thread's context, so a restricted caller could otherwise inject instructions into full-access threads. Tests: approval-required and plan-mode callers and an outside non-full-access client are refused for brief/title; allowed for pin.
2. **Brief size.** MCP-written briefs are capped at 4,000 characters (`invalid_request`, message states the limit); mention it briefly in the description.
3. Fix the misleading comment: linked callers are refused all writes.
4. **Idempotency.** Include a stable hash of the arguments in the derived command id; the same `clientRequestId` with different arguments is `invalid_request`.
5. **Project ids.** Validate `projectIds` on create against the project read model (cheap upstream service, e.g. `ProjectService.listShells`); unknown is `invalid_request`. With none given, default to the calling thread's project.
6. Log `SpaceServiceError` causes (`Effect.logWarning`, bounded annotations) before mapping to the generic MCP error.
7. **Capability-gated listing.** Provide a registration helper (e.g. `spaceToolkitRegistration`) to drop into `McpHttpServer` `layerTools`, so the toolkit is not advertised to credentials without "spaces". Mirror upstream's `toolkitRegistration` and capability filtering. Keep the handler check too. Report exact seam lines.
8. The "refuses every tool" test loop must include `space_update`.
9. Tests: fenced linked caller (writes refused, reads allowed); `space_move_thread` on another thread above the caller's mode refused; same key with different arguments; unknown project id; default project from caller.
10. Evals: add `briefExcludes` to `grade.ts` and use it in `amend-brief-keeps-rest` (`pay_retry_v2` removed). Add cases: "which space am I in" from the unfiled thread (`space: null`); moving another named thread (`threadId` argument); moving into the archived space (refusal reported, no retry loop).
11. `run.ts`: tiebreak sample when passes equal half the samples for any even sample count; add `--baseline <results.jsonl>` with a per-case comparison in `summary.md` (`evals/README.md` requires it).
12. Shorten descriptions: define "space" once (in `space_list`), drop or shorten the brief field note. Report the new byte total (was +1561 bytes on `mcpToolListJsonBytes`, 48217 to 49778).

**Eval must not use an API key (user decision).** Replace the raw `api.anthropic.com` call in `evals/fork-space/run.ts` with the headless Claude CLI: spawn `claude -p "<prompt>" --output-format stream-json --verbose --max-turns 1 --mcp-config <stub> --allowedTools "mcp__<stub>__space_*"`. The stub is a small stdio MCP server exposing the five `space_*` tool definitions (built from `tools.ts`) with canned results. The grader reads `tool_use` events from the stream. Drop the `ANTHROPIC_API_KEY` config and error. Keep `--dry-run`, `--context` and the grader tests. Note in `evals/README.md` that Claude Code's own system prompt is in play, so scores are not comparable to raw-API runs.

## Done when

`vp test run src/fork/mcp` (apps/server), `vp test run fork-space` (evals), typecheck apps/server and evals, `vp run check:changed feature/spaces`. knip 1/2 flags `evals/fork-space/run.ts` until the `evals/package.json` script seam is added (the only accepted failure). Then a fresh-context reviewer, then merge.
