import { readFile } from "node:fs/promises";
import { commands } from "../src/commands/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { skillsInstall } from "../src/commands/skills/install.js";
import { CliError } from "../src/core/errors.js";
import { emptyMeta } from "../src/core/envelope.js";
import { runCli } from "../src/cli.js";
import { ExitCode } from "../src/core/exit-codes.js";
import { envelope, testContext } from "./support/context.js";

describe("runCli", () => {
  afterEach(() => vi.restoreAllMocks());
  it("prints help with no arguments", async () => {
    const ctx = await testContext();
    expect(await runCli([], ctx)).toBe(ExitCode.Ok);
    expect(ctx.out.join("")).toContain("Usage: pidgen");
  });

  it("prints the CLI and API versions", async () => {
    const ctx = await testContext();
    expect(await runCli(["--version"], ctx)).toBe(ExitCode.Ok);
    expect(ctx.out.join("")).toBe("0.0.0-test (API 1.0)\n");
  });

  it("prints the versions for -V and for --version after global options, and lists it in help", async () => {
    for (const argv of [["-V"], ["--format", "json", "--version"], ["--timeout", "5", "-V"]]) {
      const ctx = await testContext();
      expect(await runCli(argv, ctx)).toBe(ExitCode.Ok);
      expect(ctx.out.join("")).toBe("0.0.0-test (API 1.0)\n");
    }
    const ctx = await testContext();
    expect(await runCli(["--help"], ctx)).toBe(ExitCode.Ok);
    expect(ctx.out.join("")).toMatch(/-V, --version\s+output the version number/);
  });

  it("leaves a command's own --version to the command", async () => {
    const ctx = await testContext();
    // `worker install --version <v>` names a worker release; it is not the CLI's version flag.
    expect(await runCli(["worker", "install", "--version"], ctx)).toBe(ExitCode.Usage);
    expect(ctx.out.join("")).not.toContain("0.0.0-test (API 1.0)");
    expect(envelope(ctx)).toMatchObject({ ok: false, error: { code: "CLI_USAGE" } });
  });

  it("answers an unknown command with a usage envelope", async () => {
    const ctx = await testContext();
    expect(await runCli(["frobnicate"], ctx)).toBe(ExitCode.Usage);
    expect(envelope(ctx)).toMatchObject({ ok: false, error: { code: "CLI_USAGE" } });
  });

  it("answers an unknown option with a usage envelope", async () => {
    const ctx = await testContext();
    expect(await runCli(["skills", "status", "--nope"], ctx)).toBe(ExitCode.Usage);
    expect(envelope(ctx)).toMatchObject({ ok: false, error: { code: "CLI_USAGE" } });
  });

  it("renders a table with --format table", async () => {
    const ctx = await testContext();
    // Installation has a command-specific human summary.
    await runCli(["--format", "table", "skills", "install", "--agent", "claude"], ctx);
    expect(ctx.out.join("")).toContain("distinct skills");
  });
});

// AC-67c7f52623b4, AC-f405380d2454, AC-2f37154f86b2
const terminals = [false, true].flatMap((stdout) =>
  [false, true].map((stderr) => ({ stdout, stderr })),
);
describe.each(terminals)("stdout=$stdout stderr=$stderr", ({ stdout, stderr }) => {
  it.each([undefined, "json", "table"])(
    "selects %s for execution and preserves JSON",
    async (format) => {
      const data = {
        result: [null, false, 0, "", { nested: ["x", { a: 2 }] }],
        note: "line\nnext",
      };
      const meta = {
        ...emptyMeta(),
        request_id: "req_example",
        api_version: "1.0",
        account: "ACC-EXAMPLE",
        profile: "example",
      };
      const spy = vi.spyOn(skillsInstall, "run").mockResolvedValue({ data, meta });
      try {
        const ctx = await testContext();
        Object.assign(ctx.io, { stdoutIsTTY: stdout, stdoutColumns: 60, interactive: stderr });
        const flags = format ? ["--format", format] : [];
        expect(await runCli([...flags, "skills", "install"], ctx)).toBe(0);
        const json = format === "json" || (format === undefined && !stdout);
        if (json) {
          expect(ctx.out).toHaveLength(1);
          expect(ctx.out[0]!.trim().split("\n")).toHaveLength(1);
          expect(JSON.parse(ctx.out[0]!)).toEqual({ ok: true, data, error: null, meta });
        } else {
          expect(ctx.out.join("")).toContain("result");
          expect(ctx.out.join("")).not.toContain('"ok":true');
        }
        ctx.out.length = 0;
        const details = { reason: { flags: [false, null, 4] }, preview_digest: "sha256:example" };
        spy.mockRejectedValue(
          new CliError("EXAMPLE_REFUSAL", "Cannot proceed", ExitCode.Refused, details),
        );
        expect(await runCli([...flags, "skills", "install"], ctx)).toBe(ExitCode.Refused);
        if (json)
          expect(JSON.parse(ctx.out.join(""))).toEqual({
            ok: false,
            data: null,
            error: { code: "EXAMPLE_REFUSAL", message: "Cannot proceed", details },
            meta: emptyMeta(),
          });
        else expect(ctx.out.join("")).toContain("EXAMPLE_REFUSAL: Cannot proceed");
        expect(ctx.err).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each([undefined, "json", "table"])(
    "selects %s for parser and usage errors",
    async (format) => {
      const problems = [
        { args: ["unknown-operation"], message: "unknown command" },
        { args: ["skills", "status", "--no-such-flag"], message: "unknown option" },
        { args: ["ticket", "show"], message: "missing required argument" },
        { args: ["skills", "install", "--agent", "invalid"], message: "invalid" },
        { args: ["--timeout", "zero", "skills", "status"], message: "Not a positive integer" },
        { args: ["--format", "invalid", "skills", "status"], message: "invalid" },
      ];
      for (const { args, message } of problems) {
        const ctx = await testContext();
        Object.assign(ctx.io, { stdoutIsTTY: stdout, interactive: stderr });
        const flags = format ? ["--format", format] : [];
        expect(await runCli([...flags, ...args], ctx)).toBe(2);
        const output = ctx.out.join("");
        expect(output).toContain(message);
        if (format === "json" || (format === undefined && !stdout)) {
          expect(JSON.parse(output)).toMatchObject({
            ok: false,
            data: null,
            error: { code: "CLI_USAGE" },
            meta: emptyMeta(),
          });
        } else {
          expect(output).toMatch(/^error CLI_USAGE:/);
        }
        expect(ctx.err).toEqual([]);
      }
    },
  );
});

it.each([
  ["unknown", "--format=json"],
  ["--timeout", "invalid", "skills", "status", "--format", "json"],
  ["skills", "status", "--unknown", "--format=json"],
])("recognizes explicit JSON even after a parser failure: %s", async (...argv) => {
  const ctx = await testContext();
  Object.assign(ctx.io, { stdoutIsTTY: true });
  expect(await runCli(argv, ctx)).toBe(2);
  expect(envelope(ctx)).toMatchObject({ ok: false, error: { code: "CLI_USAGE" } });
});

it.each([
  ["--profile", "--format=json", "unknown"],
  ["skills", "status", "--", "--format=json"],
])("does not mistake option values or operands for explicit JSON: %s", async (...argv) => {
  const ctx = await testContext();
  ctx.io.stdoutIsTTY = true;
  expect(await runCli(argv, ctx)).toBe(2);
  expect(ctx.out.join("")).toMatch(/^error CLI_USAGE:/);
});

it.each([
  ["unknown", "--format=table"],
  ["--timeout", "invalid", "skills", "status", "--format", "table"],
])("recognizes explicit human output after a parser failure: %s", async (...argv) => {
  const ctx = await testContext();
  expect(await runCli(argv, ctx)).toBe(2);
  expect(ctx.out.join("")).toMatch(/^error CLI_USAGE:/);
});

// AC-988b01866af2: the inventory is checked against the expanded command registry.
it("inventories every registered operation exactly once with a supported presentation category", async () => {
  const text = await readFile(new URL("../CONTRIBUTING.md", import.meta.url), "utf8");
  const section =
    text
      .split("<!-- presentation-inventory:start -->")[1]
      ?.split("<!-- presentation-inventory:end -->")[0] ?? "";
  const rows = [...section.matchAll(/^\| `([^`]+)` \| ([^|]+) \| (.+) \|$/gm)];
  const names = rows.map((row) => row[1]!);
  expect(names.sort()).toEqual(commands.map((spec) => spec.path.join(" ")).sort());
  expect(new Set(names).size).toBe(names.length);
  for (const row of rows) {
    expect([
      "list",
      "detail",
      "text",
      "status",
      "installation",
      "mutation",
      "diagnostic",
      "exception",
    ]).toContain(row[2]?.trim());
    expect(row[3]?.trim().length).toBeGreaterThan(10);
  }
  expect(text).toContain("[Presentation inventory](#presentation-inventory)");
});

// AC-13099f01c6dd: parser text exceptions also apply with explicit JSON selection.
it.each([[], ["--help"], ["auth", "--help"], ["--version"], ["-V"]].map((argv) => ({ argv })))(
  "retains parser text for $argv",
  async ({ argv }) => {
    for (const stdoutIsTTY of [false, true]) {
      const ctx = await testContext();
      ctx.io.stdoutIsTTY = stdoutIsTTY;
      expect(await runCli(argv.length ? ["--format", "json", ...argv] : [], ctx)).toBe(ExitCode.Ok);
      expect(ctx.out.join("")).toMatch(
        argv.includes("--version") || argv.includes("-V") ? /^0\.0\.0-test/ : /^Usage: pidgen/,
      );
      expect(ctx.err).toEqual([]);
    }
  },
);
