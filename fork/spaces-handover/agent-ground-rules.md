# Ground rules for builder agents (Spaces feature, Claude Code fork)

Repo: fork of T3 Code (matthias-trip/t3code). Integration branch `feature/spaces`. You work in your own git worktree under `~/Workspace/t3code-spaces-wt/<task>` on branch `task/<task>-…`, already created from `feature/spaces` with deps installed (wait for `.t3/setup-done`; if `.t3/setup-failed`, run `vp i`). Commit only there. Never modify `~/Workspace/t3code-spaces` (the integration checkout) or other worktrees. Do not push.

## Toolchain

- In every shell: `export PATH=$HOME/Workspace/t3code-spaces-wt/bin:$PATH` — `vp` is a wrapper running vite-plus on the pinned toolchain (`mise exec node@26.12.1 pnpm@12.14.0`).
- Plain node: `mise exec node@26.12.1 -- node …`, from the owning package (effect doesn't resolve from the repo root).
- Iterate: `vp test run <files>` from the owning package. Typecheck: `vp run typecheck` inside each affected package.
- Before hand-back: `vp run check:changed feature/spaces` from the worktree root (ALWAYS pass `feature/spaces`; the default base is upstream main and checks the whole fork). It should be fully green; report anything that is not.
- Never run repo-wide checks (`vp check`, `vp run -r …`).

## Read first

- `AGENTS.md` (taste, Hit every surface, Verifying, test rules), `docs/internals/effect-services.md`.
- Design: `/Users/matthias.trip/.claude-code-app/scratch/2026-11-12-goal-i-would-like-to-2441c433/t3-spaces-and-sources-proposal.md` (§3 concept model, §9 server design, §11 experience + "calm by default", §14 fork overlay). UI mockup: `t3-spaces-mockup.html` in the same folder.
- Frozen contracts (do NOT edit; report a needed change instead): `packages/fork-spaces/src/contracts/space.ts`, `packages/fork-spaces/src/contracts/rpc.ts`, the `SpaceService` interface in `apps/server/src/fork/spaces/SpaceService.ts`. Pure decider/reducer: `packages/fork-spaces/src/shared/spaces.ts`. Fixtures: `packages/fork-spaces/src/shared/spaceFixtures.ts`.

## Fork overlay rules

- Fork code lives in fork-owned paths: `packages/fork-*`, `apps/*/src/fork/**`, `packages/client-runtime/src/fork/**`, fork route files. Upstream files change daily; touching them makes the daily sync conflict.
- Do NOT edit upstream files unless your task lists the seam. If wiring needs one, do not make it: report the exact file, anchor line and the 1–3 lines to add. The orchestrator turns seams into `fork/patches.mjs` entries.
- User-visible text uses `APP_BASE_NAME` (apps/web/src/branding.ts), never a hard-coded product name. Agent-facing names stay `t3`/`space_*`.
- Exports nothing uses yet are flagged by knip; export only what a consumer or test imports.

## Safety

- Never touch `~/.claude-code-app/userdata` or `~/.t3/userdata`. No dev servers. Never kill processes by pattern. Real agent turns cost money: none needed here.

## Tests (lint enforces)

- Test behaviour that can break; no tests for what types guarantee, wiring, or static markup.
- No sleeps, wall clock, `yieldNow` polling, per-test timeouts or retries. Await a Deferred/Queue/persisted event, drain workers, or use TestClock.
- Browser tests only for real-browser behaviour (`*.browser.test.tsx`, `await using screen = await render(...)`).

## Commits

- Conventional, plain-language messages, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The pre-commit hook must pass; never `--no-verify` unless the only failure is outside your files, and say so.

## Hand-back (≤ 50 lines)

What you built, files, seams needed (file:line + exact lines), contract changes needed, test results, check:changed summary. Last line exactly:
`branch <name>, head <SHA>, tests <files: pass/fail>, open questions <…>`
