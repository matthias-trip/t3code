/** A call as graded: the tool name without the MCP server prefix, and its input. */
export type Call = { readonly tool: string; readonly input: unknown };

export type SpaceState = {
  readonly spaces: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly brief: string;
    readonly pinnedAt: string | null;
  }>;
  readonly threadSpaces: ReadonlyArray<{ readonly threadId: string; readonly spaceId: string }>;
};

export type Expect = {
  /** Each entry must match at least one call. See `matches` for the argument rules. */
  readonly calls?: ReadonlyArray<{
    readonly tool: string;
    readonly args?: Record<string, unknown>;
  }>;
  /** Tools that must not be called. A name ending in `*` is a prefix. */
  readonly callsMustNot?: ReadonlyArray<string>;
  /** The calling thread's space afterwards: a case-insensitive title substring, or null for none. */
  readonly threadSpace?: string | null;
  /** A space afterwards, by id. */
  readonly space?: {
    readonly id: string;
    readonly pinned?: boolean;
    readonly title?: string;
    readonly briefIncludes?: ReadonlyArray<string>;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Partial argument match: listed keys only. `"~text"` is a case-insensitive substring, `null`
 * matches a null or missing value, anything else must be equal.
 */
export const matches = (expected: Record<string, unknown>, input: unknown) => {
  const actual = isRecord(input) ? input : {};
  return Object.entries(expected).every(([key, want]) => {
    const got = actual[key];
    if (want === null) return got === null || got === undefined;
    if (typeof want === "string" && want.startsWith("~"))
      return typeof got === "string" && got.toLowerCase().includes(want.slice(1).toLowerCase());
    return JSON.stringify(got) === JSON.stringify(want);
  });
};

const forbidden = (pattern: string, tool: string) =>
  pattern.endsWith("*") ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern;

/** Every failed check, so a person sees why a sample failed. Empty means it passed. */
export const grade = (input: {
  readonly expect: Expect;
  readonly calls: ReadonlyArray<Call>;
  readonly state: SpaceState;
  readonly threadId: string;
}): ReadonlyArray<string> => {
  const { expect, calls, state } = input;
  const failures: Array<string> = [];
  for (const wanted of expect.calls ?? []) {
    const hit = calls.some(
      (call) => call.tool === wanted.tool && matches(wanted.args ?? {}, call.input),
    );
    if (!hit) failures.push(`no ${wanted.tool} call matching ${JSON.stringify(wanted.args ?? {})}`);
  }
  for (const pattern of expect.callsMustNot ?? []) {
    const hit = calls.find((call) => forbidden(pattern, call.tool));
    if (hit !== undefined) failures.push(`called ${hit.tool}`);
  }
  if (expect.threadSpace !== undefined) {
    const spaceId = state.threadSpaces.find((entry) => entry.threadId === input.threadId)?.spaceId;
    const title = state.spaces.find((space) => space.id === spaceId)?.title;
    if (expect.threadSpace === null) {
      if (title !== undefined) failures.push(`thread is still in "${title}"`);
    } else if (title?.toLowerCase().includes(expect.threadSpace.toLowerCase()) !== true) {
      failures.push(`thread is in ${title === undefined ? "no space" : `"${title}"`}`);
    }
  }
  if (expect.space !== undefined) {
    const want = expect.space;
    const space = state.spaces.find((candidate) => candidate.id === want.id);
    if (space === undefined) failures.push(`space ${want.id} is gone`);
    else {
      if (want.pinned !== undefined && (space.pinnedAt !== null) !== want.pinned)
        failures.push(`space is ${space.pinnedAt === null ? "not " : ""}pinned`);
      if (want.title !== undefined && space.title !== want.title)
        failures.push(`space title is "${space.title}"`);
      for (const text of want.briefIncludes ?? [])
        if (!space.brief.toLowerCase().includes(text.toLowerCase()))
          failures.push(`brief lacks "${text}"`);
    }
  }
  return failures;
};
