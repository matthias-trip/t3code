#!/usr/bin/env node
// An eval script, not server code: it writes result files directly.
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Checks that a Claude model picks the right space tool and arguments for space work, and leaves
 * spaces alone otherwise. Space tools run their real handlers on an in-memory SpaceService seeded
 * with the shared fixtures. See README.md.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { SpaceToolkit } from "../../apps/server/src/fork/mcp/space/tools.ts";
import * as SpaceHandlers from "../../apps/server/src/fork/mcp/space/handlers.ts";
import * as SpaceService from "../../apps/server/src/fork/spaces/SpaceService.ts";
import { advertisedJsonSchema } from "../../apps/server/src/mcp/advertisedJsonSchema.ts";
import * as McpInvocationContext from "../../apps/server/src/mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../apps/server/src/mcp/McpToolAccess.ts";
import { liveThreadsLayer } from "../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import { EnvironmentToolkit } from "../../apps/server/src/mcp/toolkits/environment/tools.ts";
import { ProjectToolkit } from "../../apps/server/src/mcp/toolkits/project/tools.ts";
import { ThreadToolkit } from "../../apps/server/src/mcp/toolkits/thread/tools.ts";
import {
  CLAUDE_PROVIDER,
  makeClaudeQueryOptions,
} from "../../apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { fixtureSpacesSnapshot } from "../../packages/fork-spaces/src/shared/spaceFixtures.ts";
import { cases, type Case } from "./cases.ts";
import { grade, type Call } from "./grade.ts";

// USD per million tokens.
const PRICES = {
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
} as const;
type Model = keyof typeof PRICES;
const PREFIX = "mcp__t3-code__";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "claude-sonnet-5-5" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "2" },
    concurrency: { type: "string", default: "4" },
    "max-steps": { type: "string", default: "6" },
    "dry-run": { type: "boolean", default: false },
    // Prints the space tools' advertised size, as AgentContextBudget.test.ts measures it.
    context: { type: "boolean", default: false },
  },
});
const model = values.model as Model;
if (!(model in PRICES))
  throw new Error(`--model must be one of ${Object.keys(PRICES).join(", ")}.`);

const spaceTools: ReadonlyArray<Tool.Any> = Object.values(SpaceToolkit.tools);
// Real neighbours, so the model must tell space tools from thread and project tools.
const otherTools: ReadonlyArray<Tool.Any> = [
  ThreadToolkit,
  ProjectToolkit,
  EnvironmentToolkit,
].flatMap((toolkit): ReadonlyArray<Tool.Any> => Object.values(toolkit.tools));
const advertised = (tool: Tool.Any) => ({
  name: tool.name,
  description: Tool.getDescription(tool) ?? "",
  inputSchema: advertisedJsonSchema(tool),
});

if (values.context) {
  const entries = spaceTools.map(advertised);
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  const lines = entries.map(
    (entry) =>
      `${entry.name}: ${bytes(entry)} bytes (description ${Buffer.byteLength(entry.description)})`,
  );
  // A list adds one comma per extra entry, as in AgentContextBudget's mcpToolListJsonBytes.
  lines.push(`space tools in mcpToolListJsonBytes: +${bytes(entries) - 2 + 1}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exit(0);
}

const apiTools = [
  ...[...spaceTools, ...otherTools].map((tool) => {
    const { name, description, inputSchema } = advertised(tool);
    return { name: `${PREFIX}${name}`, description, input_schema: inputSchema };
  }),
  {
    name: "Bash",
    description: "Run a shell command in the project checkout.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

const t3Instructions = (() => {
  const { systemPrompt } = makeClaudeQueryOptions({
    modelSelection: { instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER), model },
    nativeThreadId: "fork-space-eval",
    resume: false,
    cwd: null,
    mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1/mcp" } },
  });
  return typeof systemPrompt === "object" && "append" in systemPrompt ? systemPrompt.append : "";
})();

const system = (entry: Case) =>
  [
    "You are an AI coding agent running in the user's terminal, working in /home/user/acme-app (acme/app).",
    `This is T3 Code thread ${entry.threadId}.`,
    t3Instructions,
  ].join("\n\n");

const environmentId = EnvironmentId.make("environment:fork-space-eval");
const scopeFor = (entry: Case): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: `provider:${entry.threadId}`,
  thread: {
    threadId: ThreadId.make(entry.threadId),
    providerSessionId: `provider:${entry.threadId}`,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  // "spaces" is not in upstream's McpCapability list until integration.
  capabilities: new Set([
    "orchestration",
    "spaces",
  ]) as McpInvocationContext.McpInvocationScope["capabilities"],
  issuedAt: 0,
});

const ApiResponse = Schema.Struct({
  stop_reason: Schema.NullOr(Schema.String),
  content: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  usage: Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number }),
});
const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(ApiResponse));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const post = Effect.fn("evaluateForkSpace.post")(function* (body: unknown) {
  const apiKey = yield* Config.String("ANTHROPIC_API_KEY").pipe(Config.withDefault(""));
  if (!apiKey) return yield* Effect.die(new Error("Set ANTHROPIC_API_KEY in the repo root .env."));
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      schedule: Schedule.exponential("2 seconds"),
      times: 6,
    }),
  );
  const response = yield* HttpClientRequest.post("https://api.anthropic.com/v1/messages").pipe(
    HttpClientRequest.setHeaders({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" }),
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(client.execute),
  );
  const text = yield* response.text;
  if (response.status !== 200)
    return yield* Effect.die(new Error(`Model API ${response.status}: ${text}`));
  return decodeResponse(text);
});

/** Runs one space tool call through its real handler, as the MCP server would. */
const runSpaceTool = Effect.fn("evaluateForkSpace.runSpaceTool")(
  function* (name: string, input: unknown) {
    const toolkit = yield* SpaceToolkit;
    const chunks = yield* toolkit
      .handle(name as keyof (typeof SpaceToolkit)["tools"], input as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    const last = chunks.at(-1);
    return { text: encodeJson(last?.encodedResult ?? null), isError: last?.isFailure === true };
  },
  (effect, _name, _input) =>
    effect.pipe(
      Effect.catchCause((cause) => Effect.succeed({ text: String(cause), isError: true })),
    ),
);

const worldLayer = () =>
  McpToolAccess.HandlersLayer.layer(SpaceHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SpaceService.layerMemory({ initial: fixtureSpacesSnapshot }),
        liveThreadsLayer,
        SecureRandom.layerWebCrypto,
      ),
    ),
  );

const request = (entry: Case, messages: ReadonlyArray<unknown>) => ({
  model,
  max_tokens: 2048,
  system: system(entry),
  tools: apiTools,
  messages,
});

const runSample = Effect.fn("evaluateForkSpace.sample")(function* (entry: Case) {
  const messages: Array<unknown> = [{ role: "user", content: entry.prompt }];
  const calls: Array<Call> = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let final = "";
  for (let step = 0; step < Number(values["max-steps"]); step++) {
    const response = yield* post(request(entry, messages));
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    messages.push({ role: "assistant", content: response.content });
    final = response.content
      .filter((block) => block.type === "text")
      .map((block) => String(block.text))
      .join("");
    const uses = response.content.filter((block) => block.type === "tool_use");
    if (uses.length === 0) break;
    const results: Array<unknown> = [];
    for (const use of uses) {
      const name = String(use.name);
      const tool = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
      calls.push({ tool, input: use.input });
      const result = tool.startsWith("space_")
        ? yield* runSpaceTool(tool, use.input).pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(entry)),
          )
        : { text: tool === "Bash" ? "" : '{"ok":true}', isError: false };
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: result.text,
        is_error: result.isError,
      });
    }
    messages.push({ role: "user", content: results });
  }
  const spaces = yield* SpaceService.SpaceService;
  const state = yield* spaces.snapshot;
  const failures = grade({ expect: entry.expect, calls, state, threadId: entry.threadId });
  const price = PRICES[model];
  const cost = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  return { pass: failures.length === 0, failures, calls, final, cost };
});

const sample = (entry: Case, n: number) =>
  runSample(entry).pipe(
    Effect.provide(worldLayer()),
    Effect.map((result) => ({ case: entry.id, kind: entry.kind, model, sample: n, ...result })),
    Effect.catchCause((cause) =>
      Effect.succeed({ case: entry.id, kind: entry.kind, model, sample: n, error: String(cause) }),
    ),
  );
type Row = Effect.Success<ReturnType<typeof sample>>;
const passed = (row: Row) => "pass" in row && row.pass;

const selected = values.case
  ? cases.filter((entry) => values.case!.flatMap((ids) => ids.split(",")).includes(entry.id))
  : cases;

if (values["dry-run"]) {
  for (const entry of selected)
    process.stdout.write(
      `${encodeJson(request(entry, [{ role: "user", content: entry.prompt }]))}\n`,
    );
  process.exit(0);
}
if (!values.out) throw new Error("Use --out <directory> [--model <id>] [--case <ids>].");
const outDirectory = values.out;

const report = await Effect.runPromise(
  Effect.gen(function* () {
    const samples = Number(values.samples);
    const concurrency = Number(values.concurrency);
    const rows: Array<Row> = (yield* Effect.forEach(
      selected.flatMap((entry) => Array.from({ length: samples }, (_, n) => ({ entry, n }))),
      ({ entry, n }) => sample(entry, n),
      { concurrency },
    )).slice();
    // A third sample settles a split.
    const splits = selected.filter((entry) => {
      const own = rows.filter((row) => row.case === entry.id);
      return own.length === 2 && own.some(passed) && !own.every(passed);
    });
    rows.push(
      ...(yield* Effect.forEach(splits, (entry) => sample(entry, samples), { concurrency })),
    );
    NodeFS.mkdirSync(outDirectory, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(outDirectory, "results.jsonl"),
      rows.map((row) => encodeJson(row)).join("\n") + "\n",
    );
    const cost = rows.reduce((sum, row) => sum + ("cost" in row ? row.cost : 0), 0);
    const lines = [
      `# fork-space on ${model}`,
      "",
      "| case | kind | passes | failures |",
      "|---|---|---|---|",
    ];
    for (const entry of selected) {
      const own = rows.filter((row) => row.case === entry.id);
      const why = own.flatMap((row) => ("error" in row ? [row.error] : row.failures));
      lines.push(
        `| ${entry.id} | ${entry.kind} | ${own.filter(passed).length}/${own.length} | ${[...new Set(why)].join("; ")} |`,
      );
    }
    // A case fails when half or more of its samples fail.
    const failed = selected.filter((entry) => {
      const own = rows.filter((row) => row.case === entry.id);
      return own.filter(passed).length <= own.length / 2;
    });
    lines.push(
      "",
      `Cases passing: ${selected.length - failed.length}/${selected.length}. Cost: $${cost.toFixed(2)}.`,
    );
    const text = lines.join("\n") + "\n";
    NodeFS.writeFileSync(NodePath.join(outDirectory, "summary.md"), text);
    return text;
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
process.stdout.write(report);
