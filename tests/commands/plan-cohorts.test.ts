import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, testContext } from "../support/context.js";

type Body = {
  ok: boolean;
  data: {
    cohorts: { slices: string[] }[];
    summary: { cohorts: number; pull_requests: number; longest_chain_runs: number };
  };
  error: { code: string } | null;
};

async function run(ctx: Awaited<ReturnType<typeof testContext>>, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  return { code, body: envelope(ctx) as unknown as Body };
}

const SLICES = `
hotspots: [db.py]
slices:
  - id: 098/S3
    files: [src/auth.py, db.py]
  - id: 098/S4
    files: [src/auth.py]
    needs: [098/S3]
  - id: 103/S1
    files: [src/forge.py, db.py]
    needs: [098/S4]
`;

describe("pidgen plan cohorts", () => {
  it("reads a YAML slice file and proposes cohorts without calling the server", async () => {
    const ctx = await testContext();
    await writeFile(join(ctx.cwd, "slices.yaml"), SLICES);
    const { code, body } = await run(ctx, "plan", "cohorts", "-f", "slices.yaml");
    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    expect(body.data.cohorts.map((c) => c.slices)).toEqual([["098/S3", "098/S4"], ["103/S1"]]);
    expect(body.data.summary.pull_requests).toBe(2);
    expect(body.data.summary.longest_chain_runs).toBe(4);
  });

  it("honours --max-children", async () => {
    const ctx = await testContext();
    await writeFile(join(ctx.cwd, "slices.yaml"), SLICES);
    const { body } = await run(ctx, "plan", "cohorts", "-f", "slices.yaml", "--max-children", "1");
    expect(body.data.summary.cohorts).toBe(3);
  });

  it("exits 2 for input that is not a slice list", async () => {
    const ctx = await testContext();
    await writeFile(join(ctx.cwd, "bad.json"), JSON.stringify({ slices: [{ files: [] }] }));
    const { code, body } = await run(ctx, "plan", "cohorts", "-f", "bad.json");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("INPUT_INVALID");
  });

  it("exits 2 with DEPENDENCY_CYCLE for cyclic needs", async () => {
    const ctx = await testContext();
    const cyclic = {
      slices: [
        { id: "A", needs: ["B"] },
        { id: "B", needs: ["A"] },
      ],
    };
    await writeFile(join(ctx.cwd, "cycle.json"), JSON.stringify(cyclic));
    const { code, body } = await run(ctx, "plan", "cohorts", "-f", "cycle.json");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("DEPENDENCY_CYCLE");
  });

  it("rejects a non-integer --max-children", async () => {
    const ctx = await testContext();
    await writeFile(join(ctx.cwd, "slices.yaml"), SLICES);
    const { code } = await run(ctx, "plan", "cohorts", "-f", "slices.yaml", "--max-children", "x");
    expect(code).toBe(ExitCode.Usage);
  });
});

it.each([40, 80, 120])("resource presentation: cohorts at %s columns", async (columns) => {
  const ctx = await testContext();
  ctx.io.stdoutColumns = columns;
  await writeFile(join(ctx.cwd, "slices.yaml"), SLICES);
  expect(await runCli(["plan", "cohorts", "-f", "slices.yaml", "--format", "table"], ctx)).toBe(
    ExitCode.Ok,
  );
  const output = ctx.out.join("");
  for (const value of [
    "Cohort plan",
    "Cohorts (2 displayed)",
    "098/S3",
    "098/S4",
    "103/S1",
    "Shared files",
    "Edges",
    "Summary",
  ])
    expect(output).toContain(value);
  expect(ctx.err).toEqual([]);
});

// AC-941bd4e2e23a: valid file names containing spaces must remain copyable.
it.each([40, 80, 120])(
  "keeps shared paths containing spaces intact at %s columns",
  async (columns) => {
    const ctx = await testContext();
    Object.assign(ctx.io, { stdoutIsTTY: true, stdoutColumns: columns });
    const path = "src/" + "a directory with spaces/".repeat(8) + "file name.ts";
    await writeFile(
      join(ctx.cwd, "slices.json"),
      JSON.stringify({
        slices: [
          { id: "A", files: [path] },
          { id: "B", files: [path] },
        ],
      }),
    );
    expect(await runCli(["plan", "cohorts", "-f", "slices.json"], ctx)).toBe(ExitCode.Ok);
    const human = ctx.out.join("");
    expect(human).toContain("Shared files");
    expect(human).toContain(path);
    ctx.out.length = 0;
    expect(await runCli(["plan", "cohorts", "-f", "slices.json", "--format", "json"], ctx)).toBe(
      ExitCode.Ok,
    );
    expect(JSON.stringify(envelope(ctx))).toContain(path);
    expect(ctx.err).toEqual([]);
  },
);
