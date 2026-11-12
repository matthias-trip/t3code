import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { forkCapabilitiesAtom, useForkCapabilities } from "./capabilities";

describe("forkCapabilitiesAtom", () => {
  it("shares one query per environment", () => {
    const local = EnvironmentId.make("local");
    expect(forkCapabilitiesAtom(local)).toBe(forkCapabilitiesAtom(EnvironmentId.make("local")));
    expect(forkCapabilitiesAtom(local)).not.toBe(
      forkCapabilitiesAtom(EnvironmentId.make("remote")),
    );
    expect(useForkCapabilities).toBeTypeOf("function");
  });
});
