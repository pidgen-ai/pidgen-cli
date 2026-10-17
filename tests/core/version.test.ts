import { describe, expect, it } from "vitest";
import { distTag } from "../../src/core/version.js";

describe("distTag", () => {
  it.each([
    ["0.1.0-alpha.1", "alpha"],
    ["0.2.0-beta.3", "beta"],
    ["1.0.0-rc.1", "rc"],
    ["1.0.0", "latest"],
    ["0.1.0", "latest"],
  ])("%s is published under %s", (version, tag) => {
    expect(distTag(version)).toBe(tag);
  });
});
