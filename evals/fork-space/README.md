# Fork: space tools

Checks that a Claude model uses the `space_*` MCP tools (`apps/server/src/fork/mcp/space`) for space work, with the right arguments, and leaves them alone for ordinary work.

Each case is one user turn in a T3 thread. The model sees T3's real Claude instructions, the space tools, their thread, project and environment neighbours, and a `Bash` tool, all with the text and schemas from this checkout. Space tools run their real handlers on an in-memory `SpaceService` seeded with `packages/fork-spaces/src/shared/spaceFixtures.ts`, so a turn can list, read, then write. Other tools answer `{"ok":true}` and `Bash` answers nothing. The eval does not model Claude Code's deferred tool loading.

## Run

```sh
cd evals
node --env-file-if-exists=../.env fork-space/run.ts --case pin-space --samples 1 --out runs/space-check
node --env-file-if-exists=../.env fork-space/run.ts --model claude-opus-5-5 --out runs/space-opus
```

- `ANTHROPIC_API_KEY` in the repo root `.env` pays for the model.
- Flags: `--model` (`claude-sonnet-5-5` default, `claude-opus-5-5`, `claude-haiku-5-5`), `--case <ids>`, `--samples <n>` (default 2, and a 3rd when the first 2 disagree), `--concurrency <n>` (default 4), `--max-steps <n>` (default 6), `--dry-run` (prints request bodies, no key needed), `--context` (prints the space tools' advertised bytes, as `AgentContextBudget.test.ts` counts them, no key needed).
- A run writes `results.jsonl` and `summary.md` to `--out`. A case fails when half or more of its samples fail.
- Cost: 10 cases at 2 samples are about 20 short turns, well under $1 on Sonnet. The summary records each run's cost.

## Add a case

Add an entry to `cases.ts`. `guard` cases are space work; `control` cases are ordinary work that must not call space tools. `expect` (see `grade.ts`) checks calls (`calls`, `callsMustNot`) and the space state after the turn (`threadSpace`, `space`), so a case passes however the model gets there.

The first cases come from the Spaces design, not from a recorded mistake. Replace or extend them with real threads once agents use the tools.
