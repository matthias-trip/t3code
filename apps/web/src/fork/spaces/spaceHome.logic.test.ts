import { describe, expect, it } from "vite-plus/test";

import { spaceHomeLayout, validateSpaceDraft } from "./spaceHome.logic";

const space = { title: "Payments retry", brief: "Ship it." };

describe("validateSpaceDraft", () => {
  it("returns only the fields that changed, with the title trimmed", () => {
    expect(validateSpaceDraft(space, { title: "  Payments retry ", brief: "Ship it." })).toEqual({
      _tag: "valid",
      changes: {},
    });
    expect(validateSpaceDraft(space, { title: "Retry v2", brief: "" })).toEqual({
      _tag: "valid",
      changes: { title: "Retry v2", brief: "" },
    });
  });

  it("rejects a blank or over-long title and an over-long brief", () => {
    expect(validateSpaceDraft(space, { title: "   ", brief: "" })).toMatchObject({
      _tag: "invalid",
      field: "title",
    });
    expect(validateSpaceDraft(space, { title: "x".repeat(121), brief: "" })).toMatchObject({
      _tag: "invalid",
      field: "title",
    });
    expect(validateSpaceDraft(space, { title: "ok", brief: "x".repeat(20_001) })).toMatchObject({
      _tag: "invalid",
      field: "brief",
    });
  });
});

describe("spaceHomeLayout", () => {
  const overview = { value: "overview", label: "Overview", content: "brief" };
  const empty = { value: "memory", label: "Memory", content: null };
  const sources = { value: "sources", label: "Sources", content: "list" };

  it("shows tabs only when two or more sections have content", () => {
    expect(spaceHomeLayout([overview, empty, sources])).toEqual({
      _tag: "tabs",
      tabs: [overview, sources],
    });
  });

  it("shows the one section with content on its own, whichever it is", () => {
    expect(spaceHomeLayout([overview, empty])).toEqual({ _tag: "single", content: "brief" });
    expect(spaceHomeLayout([{ ...overview, content: null }, empty, sources])).toEqual({
      _tag: "single",
      content: "list",
    });
    expect(spaceHomeLayout([empty])).toEqual({ _tag: "empty" });
  });
});
