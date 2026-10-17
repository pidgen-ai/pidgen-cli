import { describe, expect, it } from "vitest";
import { kindOfToken } from "../../src/core/me.js";

describe("kindOfToken", () => {
  it.each([
    ["pidgen_cli_fake", "cli"],
    ["pidgen_pat_fake", "pat"],
    // The prefixes of tokens the server issued before it named them pidgen_.
    ["awes_cli_fake", "cli"],
    ["awes_pat_fake", "pat"],
    ["pidgen_enroll_fake", null],
    ["cli_fake", null],
    ["", null],
  ])("%j is %j", (token, kind) => {
    expect(kindOfToken(token)).toBe(kind);
  });
});
