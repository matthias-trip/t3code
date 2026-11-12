# Spaces, Sources & Attention: handover

Written 2026-11-12 when the work was stopped mid-Phase 1 so another agent can take over.
Committed at the user's request. `AGENTS.md` says not to commit plans; the user overrode that for this handover. Move or delete this folder before Spaces work goes to `claude-code` if it should not ship in the tree.

## What this is

A "Space" layer above projects and threads for the Claude Code fork of T3 Code (`matthias-trip/t3code`): linked sources (Jira, Confluence, PRs, anything) as agent-queryable context, plus an attention layer that watches PRs and similar for things needing a reaction. Built as a fork-owned overlay, with a handful of one-line "seams" into upstream files kept as `fork/patches.mjs` entries so the daily upstream sync never conflicts.

Read, in this order:

1. `design/t3-spaces-and-sources-proposal.md` (§14 wins for the fork; §11 "calm by default" UI rules; §15 open questions)
2. `design/t3-spaces-implementation-plan.md` (phases 0 to 4, waves, gates, risks)
3. `design/t3-spaces-mockup.html` (current calm mockup; `-v1` is the older busy one). `design/*.html` open in a browser.
4. `agent-ground-rules.md` (paste/point every builder brief at it; its absolute paths to the old scratch folder now live in `design/` and `notes/` here)
5. `notes/p0.1-system-scope.md`, `notes/p0.3-mcpclient.md` (spike results)

## Where things are

- Integration checkout: `~/Workspace/t3code-spaces`, branch `feature/spaces` (off `claude-code` @ `1edcb4a`, upstream v0.1.9 + rebrand). Remote `origin` = `matthias-trip/t3code`, remote `upstream` = `pingdotgg/t3code`.
- Task worktrees: `~/Workspace/t3code-spaces-wt/<task>` on `task/*` branches. Create with `git worktree add`, then install deps with `T3CODE_PROJECT_ROOT=$HOME/Workspace/t3code-spaces PATH=$HOME/Workspace/t3code-spaces-wt/bin:$PATH mise exec node@26.12.1 -- node scripts/setup-worktree.ts`.
- G0 scratch clone (local bare `origin`, safe to run `fork/sync.sh` in): `~/Workspace/t3code-spaces-wt/g0/t3code`.
- **No global `vp`.** `tooling/vp` here is the wrapper (outside git, at `~/Workspace/t3code-spaces-wt/bin/vp`): runs vite-plus on `mise exec node@26.12.1 pnpm@12.14.0`. Recreate it if missing. The system Node is 24; the repo needs 26.12.1.
- Always run `vp run check:changed feature/spaces` (the explicit base). The default base is upstream main and checks the whole fork.

## Status

Pushed to GitHub (`matthias-trip/t3code`): `feature/spaces` (includes this handover) plus `task/p1.d-mcp` @ `c0d0990ff8` and `task/p1.e-turn-context` @ `267eaf14fc`, the unfinished P1.D/P1.E drafts. Other `task/*` branches are already merged into `feature/spaces` and exist only locally. Fetch the two WIP branches and create worktrees from them (see Where things are). **`claude-code` has not been touched and must not be pushed or merged into without asking.**

| Task                                                                                                                                                                      | State                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0.1 to P0.7 (spikes, `fork-spaces` package, `fork_migrations` track, `ForkEventStore`, `fork.capabilities` RPC, seams as patches, sync tooling, `fork/check-overlay.sh`) | merged                                                                                                                                                                                                                                                                                                            |
| G0 part 1: `fork/sync.sh --no-build v0.1.9` dry run in scratch clone, and `check-overlay.sh` against upstream `main`                                                      | passed                                                                                                                                                                                                                                                                                                            |
| G0 part 2: `fork/build.sh`                                                                                                                                                | **blocked**: no Rust here. Install rustup, `rustup target add aarch64-apple-darwin`. The `claude-code-notary` profile is missing, so use `FORK_ALLOW_UNNOTARIZED=true` and a scratch `FORK_HOME` (e.g. the g0 folder). It signs with the keychain, launches the app once, writes a dmg to `$FORK_HOME/downloads`. |
| P1.0 Space contract freeze                                                                                                                                                | merged                                                                                                                                                                                                                                                                                                            |
| P1.A persisted `SpaceService`                                                                                                                                             | merged (reviewed, 10 findings fixed)                                                                                                                                                                                                                                                                              |
| P1.B spaces client state (client-runtime)                                                                                                                                 | merged (reviewed, 10 findings fixed)                                                                                                                                                                                                                                                                              |
| P1.C spaces web UI against fixtures                                                                                                                                       | merged (reviewed, 13 findings fixed)                                                                                                                                                                                                                                                                              |
| **P1.D `space_*` MCP tools + evals**                                                                                                                                      | **not merged.** Reviewed (12 findings). Fixes only partly done: `task/p1.d-mcp` @ `c0d0990ff8` is an unverified WIP commit. Brief: `p1d-fix-brief.md`.                                                                                                                                                            |
| **P1.E per-turn space context (`ForkTurnContext`)**                                                                                                                       | **not merged.** Reviewed (12 findings). Fixes only partly done: `task/p1.e-turn-context` @ `267eaf14fc` is an unverified WIP commit. Brief: `p1e-fix-brief.md`.                                                                                                                                                   |
| P1.I integration, gate G1                                                                                                                                                 | not started                                                                                                                                                                                                                                                                                                       |
| Phases 2 to 4                                                                                                                                                             | not started (plan §4 to §6)                                                                                                                                                                                                                                                                                       |

Combined `feature/spaces` has not been re-checked since the P1.A/B/C merges (each was green on its own branch). Run `check:changed`, `./fork/check-overlay.sh`, and the replay check below first.

## Do this next

1. **Finish P1.D and P1.E.** Start from the WIP commits: `git diff be57da996b..c0d0990ff8` (P1.D), `git diff 21b708d967..267eaf14fc` (P1.E). Treat them as unverified drafts. Apply the fix lists in the two briefs, run tests, then a fresh-context reviewer on the result (see Process), then merge into `feature/spaces`.
2. **P1.I integration** (orchestrator work, not a builder task):
   - Turn every seam below into a `fork/patches.mjs` `SEAMS` entry; verify with the replay check.
   - Wire UI to state: `createSpacesAtoms(runtime, { capabilities, environmentIds })` (client-runtime `fork/spaces.ts`) into `ForkSidebarTop`, `SpaceHomeRoute`, thread menu items, palette. `filterThreadsBySpace` currently matches `ThreadId` only; make it match environment + thread. `planSpaceFromTag` returns `null` for a blank tag: handle it. `onSelectSpace` should filter the sidebar and open `/spaces/$id`.
   - Advertise the capability: `packages/fork-spaces/src/server/capabilities.ts` `capabilities: []` becomes `["spaces"]`.
   - Update `apps/server/src/provider/agentContextBudget.json` (`mcpToolListJsonBytes`; was 48217 on the fork baseline, 49778 with the unshortened tools; use the measured value after P1.D's description trim).
   - One integrated pass in the real app with the `Replay (dev)` provider (`.agents/skills/test-t3-app/SKILL.md`), then gate G1 (plan §8): reviewer per branch, `check:changed`, app pass, seams in patches, `check-overlay.sh`, `sync.sh --no-build` round-trip in the g0 clone, `fork/build.sh` (needs Rust), merge to `claude-code` only with the user's say-so.
3. Then Phase 2 (plan §4): P2.0 contract freeze, then waves 2a/2b/2c.

### Seams still to add (anchor by text, never by line number; lines are from the task worktrees)

- `apps/web/package.json`: `"@t3tools/fork-spaces": "workspace:*"` after `@t3tools/contracts`. **Currently a hand edit**; reuse the `forkDependency(...)` helper in `fork/patches.mjs`.
- `packages/contracts/src/clientRpcPermissions.ts` (~:19): add `"fork.spaces.dispatch": AuthOrchestrationOperateScope,` to `CLIENT_GUARDED_RPC_SCOPES`, and extend the permission behaviour tests (AGENTS.md Taste).
- `packages/client-runtime/src/rpc/client.ts` (~:51): add `| typeof FORK_WS_METHODS.spacesSubscribe` to `EnvironmentSubscriptionRpcTag` (+ import) so spaces use the shared subscribe helper.
- Sidebar (`apps/web/src/components/Sidebar.tsx`): `<ForkSidebarTop .../>` inside `<SidebarGroup className="z-[1]">` before `<SidebarThreadHeader`; wrap `const threads = useQuietThreadShells();` with `filterThreadsBySpace(...)`; thread context menu items at ~:2632 and action handling at ~:2669 (`resolveSpaceMenuAction`); widen the id union in `threadActionMenu.logic.ts:~30`.
- `apps/web/src/components/contextMenuFallback.ts` (~:153): add the `layers` icon (the SVG paths are in P1.C's hand-back: three `path` elements of lucide "layers").
- `apps/web/src/components/CommandPalette.tsx` (~:1732): `actionItems.push(...buildSpacePaletteItems({...}))` before `buildRootGroups`.
- P1.D: add `"spaces"` to `ALL_MCP_CAPABILITIES` (`apps/server/src/mcp/McpInvocationContext.ts`), the grant lists in `orchestration-v2/ProviderSessionManager.ts` (~:492), `mcp/McpSessionRegistry.ts` (~:117), `auth/McpOAuth.ts` (~:621); register the toolkit in `mcp/McpHttpServer.ts` `layerTools` (after `layerHtmlToolkit`), preferably through a capability-gated helper so credentials without "spaces" don't see the tools; `provider/AgentContextBudget.test.ts` needs `Layer.mock(SpaceService)({})` and the new budget number; `evals/package.json` script `"fork-space": "node --env-file-if-exists=../.env fork-space/run.ts"` (knip fails without it) and a row in `evals/README.md`.
- P1.E: `packages/shared/src/composerContextReferences.ts` exports `escapeComposerContextPayloadText` (one word; committed on the task branch as `ed528f8ac4`, **must become a patch**); `orchestration-v2/ProviderTurnStartService.ts` (import, `const forkTurnContext = yield* ...`, append the block to the turn text AFTER the raw-text slash/goal-command checks, and count it in the handoff budget; exact lines come from P1.E's final hand-back); `server.ts`: `Layer.provide(ForkTurnContext.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)))` after `Layer.provide(layerScheduledTaskWebhookOrigin),`.
- `apps/server/src/fork/ForkLayer.ts` is already provided from the upstream persistence layer (seam exists as a patch in `server.ts`).

### Replay check (run after every patch change)

```bash
cd ~/Workspace/t3code-spaces
tree=$(bash -c 'source fork/lib.sh; rebrand_tree v0.1.9' 2>/dev/null)
git diff --stat HEAD $tree -- . ':!fork' ':!packages/fork-spaces' ':!apps/server/src/fork' ':!apps/web/src/fork' ':!packages/client-runtime/src/fork'
```

Empty output means the branch equals "upstream v0.1.9 + rebrand + patches + overlay". Right now it shows 4 files: `apps/web/package.json` (needs the patch above), and `routeTree.gen.ts`, the new `_chat.spaces.$spaceId.tsx`, `pnpm-lock.yaml` (all expected: regenerated or fork-owned new files). Then `./fork/check-overlay.sh [tag-or-ref]`.

## How the fork works (the parts that bite)

- `fork/rebrand.mjs` rewrites an upstream tag, `fork/patches.mjs` holds anchored edits (`why/file/find/replace/done`), `fork/lib.sh` `rebrand_tree` formats the rewritten files with this checkout's formatter. `fork/sync.sh` merges that vendor tree into `claude-code`, regenerates `routeTree.gen.ts` (`fork/routes.mjs`, merge driver `fork-ours` set via `.git/info/attributes`), typechecks the overlay, and resets on failure. Never hand-edit an upstream file without the matching `fork/` change.
- Fork data: own SQLite tables `fork_*`, own migrator table `fork_migrations` (`Migrator.make({})({ loader, table: "fork_migrations" })`: `table` is an option of the run call, not of `make`; passed to `make` it is silently ignored and collides with upstream's table).
- Fork RPCs (`fork.*`) share the environment WebSocket: server serves `WsRpcGroup.merge(ServerForkRpcGroup)`, client builds from `WsRpcGroup.merge(ForkRpcGroup)`. An upstream server answers an unknown tag with a defect for that request only; the client treats that as "no capabilities" and hides fork UI.
- Automations calling threads: do not reuse `OrchestratorMcpService` (needs an MCP caller scope). Use `ThreadLaunchService` / `ThreadManagementService` like `ScheduledTaskService` (`notes/p0.1-system-scope.md`).

## Process that worked

Per task: builder in its own worktree, then a fresh-context reviewer given only the diff and the contract (not the builder's reasoning), then a fix builder for findings that hold up, then merge. Reviewers found real bugs every time (stale state after stream failure, an escalation path through briefs, per-turn context pile-up, startup crash on one bad row). Keep doing this.

`delegate_task` runs only in the chat's own project and rejects `target.projectId`, so builder isolation is manual: create the worktree, install, then point the brief at its absolute path. A builder that dies leaves uncommitted work behind; read `git status` and `git diff HEAD` before relaunching.

Hand-back line each builder returns: `branch <name>, head <SHA>, tests <files: pass/fail>, open questions <...>`.

## Decisions already made (do not re-litigate)

- Space contracts and RPCs are frozen (`packages/fork-spaces/src/contracts/space.ts`, `rpc.ts`). Change only deliberately, then rebase dependants.
- State lives in memory behind a semaphore, rebuilt at startup by replaying `fork_events`; projections are derived. An undecodable event is logged and skipped; a load failure never kills the server.
- Overflowing a slow subscriber fails its stream with `SpaceServiceError`; clients resubscribe with backoff (P1.B) and get a fresh snapshot.
- Removing a thread from a space (`spaceId: null`) skips the thread-exists check; deleted upstream threads are filtered from snapshots.
- MCP: changing a space's title or brief requires a full-access, non-linked caller; MCP-written briefs are capped at 4,000 characters; same `clientRequestId` with different arguments is `invalid_request`.
- Turn context: the space block (4096-byte budget) is sent on first/new native thread, after compaction, and when the space content or membership changed, not on every turn. Slash and goal commands stay verbatim.
- UI: calm by default (no empty-state chrome); choosing a space filters the sidebar and opens its home page.

## Open items needing the user

- Allow pushing task branches / `claude-code`? (Only `feature/spaces` was approved.)
- No API key wanted: the `fork-space` eval is to be reworked onto headless `claude -p` (see `p1d-fix-brief.md`).
- Rust installed for the G0 build.
- Proposal §15 questions still open: default autonomy (prepare vs brief), approving from mobile, naming, steward opt-in.
