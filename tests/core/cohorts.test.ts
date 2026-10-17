import { describe, expect, it } from "vitest";
import { CohortInputSchema, pathsOverlap, proposeCohorts } from "../../src/core/cohorts.js";
import { CliError } from "../../src/core/errors.js";

type RawSlice = { id: string; files?: string[]; needs?: string[]; cohort?: string };

function plan(slices: RawSlice[], extra: Record<string, unknown> = {}) {
  return proposeCohorts(CohortInputSchema.parse({ slices, ...extra }));
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof CliError ? error.code : "not a CliError";
  }
  return undefined;
}

describe("pathsOverlap", () => {
  it("matches equal paths and a directory containing a file", () => {
    expect(pathsOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src/", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src/a.ts", "src/")).toBe(true);
    expect(pathsOverlap("src/a.ts", "src/b.ts")).toBe(false);
    expect(pathsOverlap("src", "src/a.ts")).toBe(false);
  });
});

describe("proposeCohorts", () => {
  it("groups slices that share a file and keeps disjoint slices as single roots", () => {
    const result = plan([
      { id: "A", files: ["src/auth.py"] },
      { id: "B", files: ["src/auth.py", "src/tokens.py"] },
      { id: "C", files: ["src/billing.py"] },
    ]);
    expect(result.cohorts.map((c) => c.slices)).toEqual([["A", "B"], ["C"]]);
    expect(result.cohorts[0]?.runs).toBe(3);
    expect(result.cohorts[0]?.shared_files).toEqual(["src/auth.py"]);
    expect(result.cohorts[1]?.runs).toBe(1);
    expect(result.summary.pull_requests).toBe(2);
    expect(result.summary.ready_at_start).toEqual(["C1", "C2"]);
  });

  it("treats a directory entry as overlapping every file under it", () => {
    const result = plan([
      { id: "A", files: ["ui/src/views/"] },
      { id: "B", files: ["ui/src/views/Tickets.tsx"] },
    ]);
    expect(result.cohorts.map((c) => c.slices)).toEqual([["A", "B"]]);
  });

  it("orders cohorts root to root from cross-cohort needs, and keeps inner needs as child edges", () => {
    const result = plan([
      { id: "A", files: ["x.py"] },
      { id: "B", files: ["x.py"], needs: ["A"] },
      { id: "C", files: ["y.py"], needs: ["B"] },
    ]);
    expect(result.cohorts[0]?.child_edges).toEqual([["A", "B"]]);
    expect(result.edges).toEqual([{ source: "C1", target: "C2", reason: "needs", via: ["B → C"] }]);
    expect(result.cohorts[1]?.blocked_by).toEqual(["C1"]);
    expect(result.summary.longest_chain).toEqual(["C1", "C2"]);
    expect(result.summary.longest_chain_runs).toBe(4);
    expect(result.summary.ready_at_start).toEqual(["C1"]);
  });

  it("does not group on hotspots but warns when more than two unordered cohorts edit one", () => {
    const hotspot = "tests/test_migrations.py";
    const result = plan(
      [
        { id: "A", files: ["a.py", hotspot] },
        { id: "B", files: ["b.py", hotspot] },
        { id: "C", files: ["c.py", hotspot] },
      ],
      { hotspots: [hotspot] },
    );
    expect(result.cohorts).toHaveLength(3);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "HOTSPOT_CONCURRENCY",
        hotspot,
        cohorts: ["C1", "C2", "C3"],
      }),
    ]);
  });

  it("does not warn when the cohorts on a hotspot are ordered", () => {
    const hotspot = "db.py";
    const result = plan(
      [
        { id: "A", files: ["a.py", hotspot] },
        { id: "B", files: ["b.py", hotspot], needs: ["A"] },
        { id: "C", files: ["c.py", hotspot], needs: ["B"] },
      ],
      { hotspots: [hotspot] },
    );
    expect(result.warnings).toEqual([]);
  });

  it("orders cohorts instead of joining when joining would order them both ways", () => {
    const result = plan([
      { id: "A", files: ["shared.py"] },
      { id: "B", files: ["other.py"], needs: ["A"] },
      { id: "C", files: ["shared.py"], needs: ["B"] },
    ]);
    expect(result.cohorts.map((c) => c.slices)).toEqual([["A"], ["B"], ["C"]]);
    expect(result.edges.map((e) => `${e.source}->${e.target}:${e.reason}`)).toEqual([
      "C1->C2:needs",
      "C2->C3:needs",
    ]);
    expect(result.notes[0]).toMatch(/order the cohorts both ways/);
  });

  it("starts a new cohort when one is full and orders it after the full one", () => {
    const slices = ["A", "B", "C", "D", "E"].map((id, i, ids) => ({
      id,
      files: ["core.py"],
      needs: i > 0 ? [ids[i - 1] as string] : [],
    }));
    const result = plan(slices, { max_children: 2 });
    expect(result.cohorts.map((c) => c.slices)).toEqual([["A", "B"], ["C", "D"], ["E"]]);
    expect(result.edges.map((e) => `${e.source}->${e.target}`)).toEqual(["C1->C2", "C2->C3"]);
    expect(result.summary.longest_chain_runs).toBe(3 + 3 + 1);
    expect(result.notes.some((note) => note.includes("is full"))).toBe(true);
  });

  it("adds an overlap edge between unordered cohorts that share a file", () => {
    const result = plan(
      [
        { id: "A", files: ["x.py"] },
        { id: "B", files: ["x.py"] },
      ],
      { max_children: 1 },
    );
    expect(result.edges).toEqual([
      { source: "C1", target: "C2", reason: "overlap", via: ["A ~ B"] },
    ]);
  });

  it("keeps given cohorts, proposes the edges they need, and names new cohorts around them", () => {
    const result = plan([
      { id: "A", files: ["x.py"], cohort: "C1" },
      { id: "B", files: ["x.py"], cohort: "Q" },
      { id: "C", files: ["y.py"] },
    ]);
    expect(result.cohorts.map((c) => [c.cohort, c.slices])).toEqual([
      ["C1", ["A"]],
      ["Q", ["B"]],
      ["C2", ["C"]],
    ]);
    expect(result.edges).toEqual([
      { source: "C1", target: "Q", reason: "overlap", via: ["A ~ B"] },
    ]);
  });

  it("refuses given cohorts that would each wait for the other", () => {
    expect(
      codeOf(() =>
        plan([
          { id: "A", cohort: "P" },
          { id: "B", cohort: "Q", needs: ["A"] },
          { id: "C", cohort: "P", needs: ["B"] },
        ]),
      ),
    ).toBe("COHORT_CYCLE");
  });

  it("groups dependencies too when group_dependencies is set", () => {
    const result = plan(
      [
        { id: "A", files: ["a.py"] },
        { id: "B", files: ["b.py"], needs: ["A"] },
      ],
      { group_dependencies: true },
    );
    expect(result.cohorts.map((c) => c.slices)).toEqual([["A", "B"]]);
  });

  it("refuses a dependency cycle, an unknown need, a self need, and a duplicate id", () => {
    expect(
      codeOf(() =>
        plan([
          { id: "A", needs: ["B"] },
          { id: "B", needs: ["A"] },
        ]),
      ),
    ).toBe("DEPENDENCY_CYCLE");
    expect(codeOf(() => plan([{ id: "A", needs: ["Z"] }]))).toBe("INPUT_INVALID");
    expect(codeOf(() => plan([{ id: "A", needs: ["A"] }]))).toBe("INPUT_INVALID");
    expect(codeOf(() => plan([{ id: "A" }, { id: "A" }]))).toBe("INPUT_INVALID");
  });
});
