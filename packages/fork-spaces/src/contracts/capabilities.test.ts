import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ForkCapabilities } from "./capabilities.ts";

const decode = Schema.decodeUnknownSync(Schema.toCodecJson(ForkCapabilities));

describe("ForkCapabilities", () => {
  it("drops capabilities a newer server added and keeps the known ones", () => {
    expect(
      decode({ protocolVersion: 2, capabilities: ["spaces", "telepathy", "attention"] }),
    ).toEqual({ protocolVersion: 2, capabilities: ["spaces", "attention"] });
  });

  it("rejects a payload without an integer protocol version", () => {
    expect(() => decode({ capabilities: ["spaces"] })).toThrow();
    expect(() => decode({ protocolVersion: 1.5, capabilities: [] })).toThrow();
  });
});
