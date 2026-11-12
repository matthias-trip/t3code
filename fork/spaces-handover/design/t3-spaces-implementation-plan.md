# Implementation plan: Spaces, Sources & Attention in the Claude Code fork

**Date:** 2026-11-12 · **Design:** [t3-spaces-and-sources-proposal.md](./t3-spaces-and-sources-proposal.md) (especially §14) · **Target:** `matthias-trip/t3code`, branch `claude-code` @ `1edcb4a` (upstream `v0.1.9` + rebrand)

## 1. How the work is organised

### 1.1 Branches

```text
claude-code                  ← daily fork/sync.sh merges upstream here; only gated merges from feature/spaces
 └─ feature/spaces           ← integration branch; merged from claude-code after every sync
     ├─ task/p0-scaffold     ← one branch + one git worktree per task
     ├─ task/p2-conn-web
     └─ …
```

- `claude-code` receives a phase only after its gate passes (§8), including a real sync round-trip.
- Each task runs in its **own git worktree** next to the main checkout, never in `/tmp`, per `AGENTS.md`. The worktree is branched from `feature/spaces`. The `t3.json` setup script (`scripts/setup-worktree.ts`) installs dependencies there.
- Seam edits to upstream files are made directly while a phase is in flight. At the phase gate they are **moved into `fork/patches.mjs`** (proposal §14.5), so `claude-code` never carries hand edits to upstream files.

### 1.2 Who does what

| Role                | Who                               | Responsibilities                                                                                                                                                                                                  |
| ------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orchestrator**    | Main session                      | Freezes contracts, writes task briefs, merges task branches, owns seams and `patches.mjs`, runs the one integrated app pass per phase (`test-t3-app`), merges `claude-code` into `feature/spaces` after each sync |
| **Builder agents**  | Sub-agents in isolated worktrees  | One task each. Edit only the files the task owns. Run focused tests. Return a branch + head SHA + test output                                                                                                     |
| **Explorer agents** | Read-only sub-agents              | Spikes and investigations; return findings with `file:line`                                                                                                                                                       |
| **Reviewer agent**  | Fresh-context sub-agent per merge | Gets the diff and the contract, not the builder's reasoning. Correctness, `AGENTS.md` taste rules, test quality                                                                                                   |

### 1.3 The rule that makes parallel work possible: contracts first

Each phase starts with a **contract freeze**, done by the orchestrator in one small PR to `feature/spaces`:

- the schemas in `packages/fork-spaces/src/contracts`
- the service tags (`Context.Service` interfaces) with **stub layers**
- the RPC method signatures
- test fixtures

After the freeze, server, client-runtime, UI, MCP, and connector work runs in parallel against the stubs, because no two tasks own the same file. A builder that needs a contract change **does not make it**. It reports the change, the orchestrator amends the contract, and the dependants rebase.

### 1.4 Ground rules for every agent brief

These come from `AGENTS.md` and the fork, and are copied into every task brief:

- **Stay in owned files.** Never edit files outside the task's list. Upstream files only through the seams listed in the task.
- **Commands.**
  - `vp i` installs (or wait for `.t3/setup-done`).
  - `vp test run <files>` while iterating.
  - `vp run typecheck` for affected packages.
  - `vp run check:changed` before handing back.
  - Never run repo-wide checks (`vp check`, `vp run -r test`).
- **Never touch live data.** Not `~/.claude-code-app/userdata` and not `~/.t3/userdata`. For realistic data, use `vp run migrate-dev-db` with the source set explicitly to a copy of `~/.claude-code-app/userdata/statev2.sqlite` (its default is `~/.t3`).
- **Process hygiene.** Sub-agents do not start dev servers. Never kill processes by pattern.
- **Tests.** Event-sourcing tests drain the worker or await a persisted event. No sleeps, polling, or timeouts (the lint rules enforce this). Logic gets unit tests (`*.logic.test.ts`). Browser tests only for real-browser behaviour.
- **Effect style.** `Effect.fn("Service.operation")` for reusable functions. Transports stay thin: one service call per handler.
- **Naming.** Fork UI text uses `APP_BASE_NAME`. Agent-facing names stay `t3-*` / `sources_*` / `watch_*`.
- **Cost.** Real agent turns cost money. Use the `Replay (dev)` provider, or the cheapest model only when provider behaviour matters.
- **Hand-back line.** `branch <name>, head <SHA>, tests <files: pass/fail>, open questions`.

## 2. Phase 0: overlay scaffolding

Goal: an **empty** overlay that survives a real sync. No user-visible feature.

| ID   | Task                                                                                                                                                                                                                                                                              | Depends          | Wave | Agent        | Owns                                                                                                            | Done when                                                                                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---- | ------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0.1 | **Spike: system scope for `OrchestratorMcpService`.** How do scheduled tasks call `createThreads` / `sendToThread` / `readThread` without an MCP caller? Can the fork build an equivalent scope?                                                                                  | —                | A    | Explorer     | —                                                                                                               | Note with the call path, the scope constructor, and permission implications                                                                                              |
| P0.2 | **Spike: patches round-trip.** Add a dummy patch to `fork/patches.mjs`, run `node fork/rebrand.mjs` on a `v0.1.9` worktree, and check that `done` is idempotent. Prototype the `routeTree.gen.ts` keep-ours merge driver plus regeneration, and find the exact regenerate command | —                | A    | Builder      | `fork/` only (on a task branch)                                                                                 | Transcript of rebrand, merge, regenerate, typecheck                                                                                                                      |
| P0.3 | **Spike: Effect `McpClient`** (`.repos/effect/packages/effect/src/ai/McpClient.ts`): HTTP/SSE transport, OAuth support, tool and resource calls                                                                                                                                   | —                | A    | Explorer     | —                                                                                                               | Note: feasible yes/no, gaps, and an OAuth plan for phase 3                                                                                                               |
| P0.4 | `packages/fork-spaces` skeleton: `contracts` / `shared` / `server` subpath exports, tsconfig, lint boundary (no UI in `shared/`)                                                                                                                                                  | —                | A    | Builder      | `packages/fork-spaces/**`                                                                                       | `vp run typecheck` passes for the package                                                                                                                                |
| P0.5 | `ForkMigrations` (`Migrator.make({ table: "fork_migrations" })`), `ForkEventStore` (`fork_events`, receipts, single-transaction commit), `ForkLayer`                                                                                                                              | P0.4             | B    | Builder      | `apps/server/src/fork/persistence/**`, `apps/server/src/fork/ForkLayer.ts`                                      | Tests: fork migrations run after upstream ones; **a simulated later upstream migration still runs**; event + projection + receipt commit atomically; retry is idempotent |
| P0.6 | `ForkRpcGroup` with `fork.capabilities`; server handler; `useForkCapabilities` in `apps/web/src/fork/`                                                                                                                                                                            | P0.4             | B    | Builder      | `packages/fork-spaces/src/contracts/rpc.ts`, `apps/server/src/fork/rpc/**`, `apps/web/src/fork/capabilities.ts` | Unit test: UI hidden when capability absent (upstream server)                                                                                                            |
| P0.7 | Seams 1–2 (`server.ts`, `rpc.ts` / `ws.ts`) + root `package.json` `knip` workspace entry as **patches**; `.gitattributes` + merge driver; `fork/sync.sh` regenerate step; `fork/check-overlay.sh`                                                                                 | P0.2, P0.5, P0.6 | C    | Orchestrator | `fork/**`, `.gitattributes`                                                                                     | `fork/check-overlay.sh` passes. It rebrands the current tag, applies the patches, merges into a temp branch, then typechecks and tests affected packages                 |

**Parallelism:** Wave A runs 4 agents at once (P0.1–P0.4). Wave B runs 2 (P0.5, P0.6). Wave C is the orchestrator alone.

**Gate G0:** `fork/sync.sh --no-build` on a scratch clone, then `fork/build.sh` produces a launchable app. Merge to `claude-code`.

## 3. Phase 1: Spaces

| ID   | Task                                                                                                                                                                                                                                                                        | Depends   | Wave | Agent        | Owns                                                       | Done when                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- | ------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| P1.0 | **Contract freeze:** `Space`, `SpaceId`, `fork_thread_spaces`, commands (`space.create/update/archive/unarchive/delete`, `thread.space.set`), events, RPCs, stub layers, fixtures                                                                                           | G0        | A    | Orchestrator | `packages/fork-spaces/src/contracts/space.ts`              | Reviewed and merged                                                                             |
| P1.A | Server domain: decider, projections (`fork_spaces`, `fork_space_projects`, `fork_thread_spaces`), RPC handlers, `SpaceService`                                                                                                                                              | P1.0      | B    | Builder      | `apps/server/src/fork/spaces/**`                           | Decider tests for every command, including reverse states; projection tests; idempotent retries |
| P1.B | Client state: subscription, per-environment merge, selectors (threads in a space)                                                                                                                                                                                           | P1.0      | B    | Builder      | `packages/client-runtime/src/fork/spaces.ts` (new file)    | Logic tests: multi-environment, reconnect from snapshot cursor                                  |
| P1.C | Web UI against fixtures: `ForkSidebarTop` (space switcher, Inbox entry placeholder), `_chat.spaces.$spaceId.tsx` (overview: brief, _Needs you_ placeholder, sources placeholder), sidebar filtering by space, _Move to space_, _Make space from tag_, command palette items | P1.0      | B    | Builder      | `apps/web/src/fork/spaces/**`, route file                  | Logic tests; follows the "calm by default" rules (proposal §11)                                 |
| P1.D | MCP `space_*` toolkit (list, read, create, move thread); capability `"sources"` placeholder; tool-description evals                                                                                                                                                         | P1.0      | B    | Builder      | `apps/server/src/fork/mcp/space/**`, `evals/fork-space/**` | Handler tests; evals pass                                                                       |
| P1.E | `ForkTurnContext`: per-turn contribution service with a budget; injects the brief                                                                                                                                                                                           | P1.0      | B    | Builder      | `apps/server/src/fork/context/**`                          | Tests: budget, escaping (reuse `composerContextReferences` escaping), ordering                  |
| P1.I | **Integration:** wire P1.B to P1.C; seams 3–7 for this phase (MCP toolkit, capability, turn context, sidebar slot); one `test-t3-app` pass with Replay                                                                                                                      | all above | C    | Orchestrator | seams                                                      | App pass recorded; reviewer agent report on each merged branch                                  |

**Parallelism:** Wave B runs 5 agents at once (P1.A–P1.E), all against the frozen contract.

**Gate G1:** the integrated pass, then seams moved to `patches.mjs`, `check-overlay.sh` green, and a sync round-trip. Merge to `claude-code`.

## 4. Phase 2: Sources, first agentic loop, PR attention

This is the largest phase and the most parallel.

### 4.1 Contract freeze (orchestrator)

**P2.0** freezes these, with stubs and fixtures:

- `Source`, `SourceLink`, `SourceSnapshot`, lifecycle
- `ConnectorDefinition`, `ConnectorDriver`, capabilities
- `SourceChange`
- `Signal`, `SignalKind`, `Watch`, `Policy`, `InboxItem`, publish-ledger entry
- service tags: `SourceStore`, `ConnectorRegistry`, `SourceIndex`, `SignalBus`, `SignalRouter`, `PolicyRunner`

It also adds `packages/fork-connector-testing`, a fake connector and a contract test suite that every connector must pass, mirroring `packages/source-control-testing`.

### 4.2 Waves

| ID   | Task                                                                                                                                                                | Depends      | Wave | Agent        | Owns                                                                                            | Done when                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---- | ------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| C1   | Connector core: registry (duplicate kinds rejected, URL claim order), `defineConnector` / `defineConnectorDriver`, `SettingsSecretValue` credentials                | P2.0         | 2a   | Builder      | `packages/fork-spaces/src/{shared,server}/connector/**`                                         | Registry tests; the contract suite runs against the fake connector                       |
| S1   | Source domain: link / unlink / update, tombstones, effective-set resolution (pure, in `shared/`)                                                                    | P2.0         | 2a   | Builder      | `apps/server/src/fork/sources/domain/**`, `packages/fork-spaces/src/shared/effectiveSources.ts` | Table tests for precedence and exclusion; decider tests                                  |
| S2   | Content cache + FTS5 trigram index (`fork_source_content`, `fork_source_content_search`) behind `SourceIndex`                                                       | P2.0         | 2a   | Builder      | `apps/server/src/fork/sources/index/**`                                                         | Tests mirroring `069_ThreadMessageSearch`; fallback when FTS5 is unavailable             |
| A1   | Signal bus + router: thread, then space, then personal affinity; coalescing window; fingerprints; publish ledger                                                    | P2.0         | 2a   | Builder      | `apps/server/src/fork/attention/{SignalBus,SignalRouter,PublishLedger}.ts`                      | Pure-logic tests: 12-comment review gives 1 wake; own comments never wake; routing table |
| U1   | Web against fixtures: sources pill + popover (`ForkThreadSources`), sources tab, link dialog, `@` source picker UI                                                  | P2.0         | 2a   | Builder      | `apps/web/src/fork/sources/**`                                                                  | Logic tests; calm rules                                                                  |
| U2   | Web against fixtures: `_chat.inbox.tsx` list + detail, approval card, _Details_ disclosure                                                                          | P2.0         | 2a   | Builder      | `apps/web/src/fork/inbox/**`, route file                                                        | Logic tests; calm rules                                                                  |
| C2   | `fork-connector-web` (readable-text extraction, ETag/Last-Modified polling)                                                                                         | C1           | 2b   | Builder      | `packages/fork-connector-web/**`                                                                | Contract suite passes                                                                    |
| C3   | `fork-connector-file` (paths and globs in a project, fs watch)                                                                                                      | C1           | 2b   | Builder      | `packages/fork-connector-file/**`                                                               | Contract suite passes                                                                    |
| C4   | `fork-connector-note` (T3-native markdown notes, memory entries)                                                                                                    | C1           | 2b   | Builder      | `packages/fork-connector-note/**`                                                               | Contract suite passes                                                                    |
| C5   | `fork-connector-thread` (title + summary of another thread via `readThread`)                                                                                        | C1, P0.1     | 2b   | Builder      | `packages/fork-connector-thread/**`                                                             | Contract suite passes                                                                    |
| C6   | `fork-connector-change-request` (wraps `PullRequestService`; emits PR signals with `evaluatePullRequestWatch` as a library)                                         | C1, A1       | 2b   | Builder      | `packages/fork-connector-change-request/**`                                                     | Contract suite passes; signal tests from recorded PR fixtures                            |
| S3   | `SourceSyncReactor`: `isDue` cadence by lifecycle, per-connector batching and rate limits, snapshot events                                                          | S1, C1       | 2c   | Builder      | `apps/server/src/fork/sources/sync/**`                                                          | Drain-based tests; no wall-clock                                                         |
| S4   | Agent context: manifest, change deltas, per-turn relevance excerpts through `ForkTurnContext`                                                                       | S1, S2, P1.E | 2c   | Builder      | `apps/server/src/fork/context/sources/**`                                                       | Budget and citation tests; evals for the manifest text                                   |
| S5   | MCP `sources_*` toolkit (`list`, `read`, `search`, `link`, `unlink`, `refresh`, `suggest`)                                                                          | S1, S2       | 2c   | Builder      | `apps/server/src/fork/mcp/sources/**`, `evals/fork-sources/**`                                  | Handler tests; evals                                                                     |
| A2   | PR me-watches: review requested, reviews/comments on my PRs, CI, conflicts; handling-environment election                                                           | A1, C6       | 2c   | Builder      | `apps/server/src/fork/attention/watches/**`                                                     | Tests from recorded fixtures; no duplicate runs across two environments                  |
| A3   | `PolicyRunner`: notify / brief / prepare via `OrchestratorMcpService` (system scope from P0.1); worktree on the PR branch; hold-as-question                         | A1, P0.1     | 2c   | Builder      | `apps/server/src/fork/attention/PolicyRunner.ts`, playbooks                                     | Tests with the Replay provider; a hold never publishes                                   |
| D1   | Discovery: read-only orchestration event subscriber, sightings, inbox suggestions                                                                                   | S1, A1       | 2c   | Builder      | `apps/server/src/fork/sources/discovery/**`                                                     | Tests: threshold, tombstones respected                                                   |
| P2.I | **Integration:** wire U1/U2 to state; composer `source` chip (see risk R2); seams 3–8 completed; `test-t3-app` pass (PR comment arrives → prepared reply → approve) | all above    | 2d   | Orchestrator | seams                                                                                           | App pass recorded; reviewer report per branch                                            |

**Parallelism:**

- Wave 2a runs 6 agents (C1, S1, S2, A1, U1, U2).
- Wave 2b runs 5 (C2–C6), one package each, so they cannot collide.
- Wave 2c runs 6 (S3, S4, S5, A2, A3, D1).
- C2–C5 can start as soon as C1 merges, overlapping the end of wave 2a. C6 also needs A1.

**Gate G2:** integrated pass, patches, `check-overlay.sh`, sync round-trip, then a week of daily use on your own PRs before merging to `claude-code`.

## 5. Phase 3: bridged connectors + reactions

| ID   | Task                                                                                                                                 | Depends | Wave | Agent        | Owns                                                | Done when                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ | ------- | ---- | ------------ | --------------------------------------------------- | ---------------------------------------------------------------- |
| B1   | MCP client service on the server (Effect `McpClient`): HTTP/SSE, OAuth sign-in on the environment, credentials via secret references | P0.3    | 3a   | Builder      | `apps/server/src/fork/mcpClient/**`                 | Tests against an in-process fixture MCP server                   |
| B2   | Declarative bridge engine: match, then uri; tool + args; field mapping; lifecycle map; MCP `resources/read` path                     | B1, C1  | 3b   | Builder      | `packages/fork-connector-mcp-bridge/**`             | Contract suite passes using fixture Jira/Confluence-shaped tools |
| B3   | Settings → Connectors (list, add from MCP server, _test with a URL_); Settings → Watches                                             | P2.0    | 3a   | Builder      | `apps/web/src/fork/settings/**`, route files        | Logic tests; calm rules                                          |
| B4   | `t3.json` `sources`: the fork reads the raw file itself; no upstream schema change                                                   | S1      | 3a   | Builder      | `apps/server/src/fork/sources/projectFile.ts`       | Tests: added, removed, and tombstoned entries                    |
| B5   | Query sources (`members`) + `member-added` / `member-removed` changes                                                                | B2, S3  | 3c   | Builder      | `apps/server/src/fork/sources/query/**`             | Tests                                                            |
| R1   | Reactions: a fork runner reusing `PolicyRunner` (no change to `ScheduledTaskService`); inform / wake / start / ask-steward           | A3, S3  | 3a   | Builder      | `apps/server/src/fork/reactions/**`                 | Drain-based tests; budgets enforced                              |
| A4   | Signals from bridged connectors: assigned, mention, doc comment, alert                                                               | B2, A1  | 3c   | Builder      | `packages/fork-connector-mcp-bridge/src/signals/**` | Fixture tests                                                    |
| P3.I | **Integration:** your real Atlassian MCP configured as Jira + Confluence connectors; app pass                                        | all     | 3d   | Orchestrator | —                                                   | Recorded pass                                                    |

**Parallelism:** Wave 3a runs 4 agents (B1, B3, B4, R1). Wave 3b runs B2 alone. Wave 3c runs 2 (B5, A4).

## 6. Phase 4: steward, memory, actions

| ID  | Task                                                                                                    | Depends | Wave | Agent   | Owns                                                              |
| --- | ------------------------------------------------------------------------------------------------------- | ------- | ---- | ------- | ----------------------------------------------------------------- |
| ST1 | Space steward: pinned thread, editable playbook, wake schedule, budgets, suggestions-only output        | R1      | 4a   | Builder | `apps/server/src/fork/steward/**`                                 |
| M1  | Memory: distil on settle via the text-generation service; `space_memory_*` tools; retrieval feeds S4    | S4      | 4a   | Builder | `apps/server/src/fork/memory/**`                                  |
| X1  | Actions as proposals: connector `runAction`, `sources_propose_action`, approval card                    | B2, U2  | 4a   | Builder | `apps/server/src/fork/actions/**`, `apps/web/src/fork/actions/**` |
| X2  | `act` policy level + guards (never merge, never force-push, own PRs only)                               | A3      | 4b   | Builder | `apps/server/src/fork/attention/act/**`                           |
| X3  | Webhook connectors, `settlesThread` (dispatching `thread.settle`), `SourceIndex` vector seam (optional) | S3      | 4b   | Builder | per package                                                       |

**Parallelism:** Wave 4a runs 3 agents. Wave 4b runs 2.

## 7. Critical path

```text
P0.4 → P0.5/P0.6 → P0.7 → G0 → P1.0 → P1.A/P1.B → P1.I → G1
     → P2.0 → C1 → C6 → A2 → P2.I → G2
                  └→ (A1) → A3 ┘
```

Everything else hangs off this path in parallel waves. The two items most likely to slow it are **P0.1** (system scope) and **R2** (composer chip, below). Both are resolved early: P0.1 is a wave-A spike, and R2 is decided at the P2.0 freeze.

## 8. Gates (every phase)

1. Every task branch has passed a reviewer agent (fresh context, diff + contract only). Fix the findings that hold up; dismiss false positives with a written reason.
2. `vp run check:changed` passes on `feature/spaces`.
3. One integrated app pass with `test-t3-app` and the Replay provider, recorded.
4. Seams moved to `fork/patches.mjs`, and `fork/check-overlay.sh` passes against the current upstream tag.
5. A real `fork/sync.sh --no-build` round-trip on a scratch clone, then `fork/build.sh`.
6. Merge `feature/spaces` into `claude-code`.

## 9. Risks and how the plan handles them

| ID  | Risk                                                                                                | Mitigation                                                                                                                                                                | When           |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| R1  | `OrchestratorMcpService` methods expect an MCP caller scope                                         | P0.1 spike. Fallback: call the services the scheduled-task runner uses                                                                                                    | Phase 0        |
| R2  | Composer chips render per kind; a new `source` kind needs a chip renderer in upstream composer code | Decide at P2.0: either one more slot seam in the composer chip switch, or render `source` mentions as plain links (upstream already passes unknown kinds to the provider) | Phase 2 freeze |
| R3  | `routeTree.gen.ts` changes on every upstream route change                                           | P0.2 merge driver + regeneration in `sync.sh`                                                                                                                             | Phase 0        |
| R4  | Root `package.json` lists `knip` workspaces by hand                                                 | Patch seam in P0.7; one entry per fork package via a glob, if `knip` accepts it                                                                                           | Phase 0        |
| R5  | Upstream moves a seam anchor                                                                        | `rebrand.mjs` stops the sync before touching the branch; the orchestrator re-anchors. Keep anchors on stable lines (exports, list heads)                                  | Ongoing        |
| R6  | `claude-code` moves during a phase                                                                  | The orchestrator merges `claude-code` into `feature/spaces` after every sync; builders rebase their task branches before hand-back                                        | Ongoing        |
| R7  | GitHub rate limits from me-watches                                                                  | Reuse `PullRequestService` read caching; one handling environment; fingerprint-based reread cadence                                                                       | Phase 2        |
| R8  | Agent cost from `prepare` policies                                                                  | Default model per policy, daily budget, quiet hours; Replay provider in all tests                                                                                         | Phase 2        |
| R9  | Contract churn breaks parallel tasks                                                                | Contracts change only through the orchestrator; dependants rebase                                                                                                         | Ongoing        |

## 10. Sub-agent tooling and size

- **How to run them.**
  - Builders: the Agent tool with `isolation: "worktree"`, or T3 `delegate_task` with a worktree when another provider or model is wanted.
  - Explorers: `Explore` agents.
  - Reviewers: fresh `general-purpose` or code-review agents given only the diff and the contract.
- **Concurrency.** At most 6 builders per wave. Waves 2a and 2c are the widest.
- **Agent counts.** Phase 0: 6 agents. Phase 1: 5 builders + reviewers. Phase 2: 17 builders + reviewers. Phase 3: 7. Phase 4: 5.
- **What each brief contains:**
  - the task row
  - the frozen contract files
  - the owned-file list
  - the ground rules (§1.4)
  - the acceptance tests
  - the hand-back line

  Builders never see other builders' reasoning, only merged code.

- **Phases 1–4 need opt-in.** They involve many agent runs. Workflow orchestration (a multi-agent script) only if you ask for it. Otherwise the orchestrator launches each wave's agents directly.
