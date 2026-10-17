import * as z from "zod";
import { CliError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";

/**
 * Proposes delivery cohorts for a batch of planned slices (`pidgen plan cohorts`).
 *
 * Every root ticket is one workspace and one pull request. Roots that run at the same time and edit
 * the same existing files conflict when the second pull request lands. Two slices that share a file
 * therefore either join one cohort (one root whose children run one at a time) or sit in cohorts
 * ordered by a root-to-root `blocks` edge. A root completes only when its pull request has landed,
 * so such an edge waits for the merge and the two never edit the file at once.
 *
 * Pure and local: nothing here talks to a server.
 */

const SliceSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  files: z.array(z.string().min(1)).default([]),
  needs: z.array(z.string().min(1)).default([]),
  /** A cohort this slice is already assigned to; slices without one are placed automatically. */
  cohort: z.string().min(1).optional(),
});

export const CohortInputSchema = z.object({
  slices: z.array(SliceSchema).min(1),
  hotspots: z.array(z.string().min(1)).default([]),
  max_children: z.number().int().min(1).default(6),
  group_dependencies: z.boolean().default(false),
});

export type CohortInput = z.infer<typeof CohortInputSchema>;
type Slice = z.infer<typeof SliceSchema>;

export interface Cohort {
  cohort: string;
  slices: string[];
  /** Runs this cohort costs: one for a single slice, else its children plus the root's turn. */
  runs: number;
  blocked_by: string[];
  /** Existing files edited by more than one of this cohort's slices. */
  shared_files: string[];
  hotspots: string[];
  /** `[source, target]` slice pairs ordered inside the cohort's shared workspace. */
  child_edges: [string, string][];
}

export interface CohortEdge {
  source: string;
  target: string;
  reason: "needs" | "overlap";
  via: string[];
}

export interface CohortWarning {
  code: "HOTSPOT_CONCURRENCY";
  hotspot: string;
  cohorts: string[];
  message: string;
}

export interface CohortPlan {
  cohorts: Cohort[];
  edges: CohortEdge[];
  summary: {
    slices: number;
    cohorts: number;
    pull_requests: number;
    longest_chain_runs: number;
    longest_chain: string[];
    ready_at_start: string[];
  };
  warnings: CohortWarning[];
  notes: string[];
}

function planError(code: string, message: string, details: Record<string, unknown> = {}): CliError {
  return new CliError(code, message, ExitCode.Usage, details);
}

function normalize(path: string): string {
  return path.replace(/^\.\//, "");
}

/** Two paths overlap when equal, or when one is a directory (trailing `/`) containing the other. */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith("/") && b.startsWith(a)) return true;
  if (b.endsWith("/") && a.startsWith(b)) return true;
  return false;
}

function isHotspot(path: string, hotspots: string[]): boolean {
  return hotspots.some((hotspot) => pathsOverlap(path, hotspot));
}

/** Kahn's algorithm, ties broken by input order. Returns null when the graph has a cycle. */
function topoOrder(nodes: number[], edges: [number, number][]): number[] | null {
  const indegree = new Map(nodes.map((n) => [n, 0]));
  const out = new Map<number, number[]>(nodes.map((n) => [n, []]));
  for (const [s, t] of edges) {
    out.get(s)?.push(t);
    indegree.set(t, (indegree.get(t) ?? 0) + 1);
  }
  const ready = nodes.filter((n) => indegree.get(n) === 0).sort((a, b) => a - b);
  const order: number[] = [];
  while (ready.length > 0) {
    const n = ready.shift() as number;
    order.push(n);
    for (const t of out.get(n) ?? []) {
      const d = (indegree.get(t) ?? 0) - 1;
      indegree.set(t, d);
      if (d === 0) {
        ready.push(t);
        ready.sort((a, b) => a - b);
      }
    }
  }
  return order.length === nodes.length ? order : null;
}

/** Finds one cycle among slices, as ids, for the error message. */
function findCycle(slices: Slice[], edges: [number, number][]): string[] {
  const out = new Map<number, number[]>();
  for (const [s, t] of edges) out.set(s, [...(out.get(s) ?? []), t]);
  const state = new Map<number, 1 | 2>();
  const stack: number[] = [];
  const visit = (n: number): number[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const t of out.get(n) ?? []) {
      if (state.get(t) === 1) return [...stack.slice(stack.indexOf(t)), t];
      if (!state.has(t)) {
        const found = visit(t);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (let i = 0; i < slices.length; i++) {
    if (!state.has(i)) {
      const found = visit(i);
      if (found) return found.map((n) => (slices[n] as Slice).id);
    }
  }
  return [];
}

/** Cohorts under construction: members plus root-to-root edges with their reasons. */
class CohortGraph {
  readonly members: number[][] = [];
  readonly labels: string[] = [];
  /** Whether the cohort was named in the input; only generated cohorts take automatic joins. */
  readonly assigned: boolean[] = [];
  readonly edges = new Map<string, CohortEdge>();
  private readonly out = new Map<number, Set<number>>();
  private generated = 0;

  constructor(private readonly reserved: Set<string>) {}

  name(c: number): string {
    return this.labels[c] as string;
  }

  indexOf(label: string): number {
    return this.labels.indexOf(label);
  }

  add(slice: number, label?: string): number {
    let name = label;
    while (name === undefined || (label === undefined && this.reserved.has(name))) {
      this.generated++;
      name = `C${this.generated}`;
    }
    this.members.push([slice]);
    this.labels.push(name);
    this.assigned.push(label !== undefined);
    return this.members.length - 1;
  }

  reaches(from: number, to: number): boolean {
    if (from === to) return true;
    const seen = new Set<number>([from]);
    const stack = [from];
    while (stack.length > 0) {
      for (const next of this.out.get(stack.pop() as number) ?? []) {
        if (next === to) return true;
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  }

  ordered(a: number, b: number): boolean {
    return this.reaches(a, b) || this.reaches(b, a);
  }

  link(source: number, target: number, reason: CohortEdge["reason"], via: string): void {
    if (source === target) return;
    const key = `${source}->${target}`;
    const edge = this.edges.get(key) ?? {
      source: this.name(source),
      target: this.name(target),
      reason,
      via: [],
    };
    if (reason === "needs") edge.reason = "needs";
    if (!edge.via.includes(via)) edge.via.push(via);
    this.edges.set(key, edge);
    this.out.set(source, (this.out.get(source) ?? new Set()).add(target));
  }
}

/**
 * Groups slices into cohorts, one slice at a time in dependency order.
 *
 * A slice joins the cohort it shares the most non-hotspot files with (or, with
 * `group_dependencies`, the cohort of a slice it needs) when that cohort has room under
 * `max_children` and joining creates no cycle between cohorts. Otherwise it starts a new cohort,
 * and every earlier cohort it shares a file with and is not already ordered against gets a
 * root-to-root `overlap` edge into it, so the two never run at once. Dependencies across cohorts
 * become `needs` edges. The result reports the longest chain in runs, the cohorts ready at the
 * start, and hotspots that more than two unordered cohorts could edit at once.
 */
export function proposeCohorts(input: CohortInput): CohortPlan {
  const slices = input.slices.map((slice) => ({
    ...slice,
    files: [...new Set(slice.files.map(normalize))],
  }));
  const hotspots = input.hotspots.map(normalize);
  const indexOf = new Map<string, number>();
  slices.forEach((slice, i) => {
    if (indexOf.has(slice.id)) {
      throw planError("INPUT_INVALID", `Slice id ${slice.id} appears more than once`, {
        slice: slice.id,
      });
    }
    indexOf.set(slice.id, i);
  });

  const needs: [number, number][] = [];
  for (const [target, slice] of slices.entries()) {
    for (const need of new Set(slice.needs)) {
      const source = indexOf.get(need);
      if (source === undefined) {
        throw planError("INPUT_INVALID", `Slice ${slice.id} needs unknown slice ${need}`, {
          slice: slice.id,
          needs: need,
        });
      }
      if (source === target) {
        throw planError("INPUT_INVALID", `Slice ${slice.id} needs itself`, { slice: slice.id });
      }
      needs.push([source, target]);
    }
  }
  const all = slices.map((_, i) => i);
  const order = topoOrder(all, needs);
  if (order === null) {
    const cycle = findCycle(slices, needs);
    throw planError("DEPENDENCY_CYCLE", `Slice dependencies form a cycle: ${cycle.join(" → ")}`, {
      cycle,
    });
  }

  const id = (i: number) => (slices[i] as Slice).id;
  const ownFiles = slices.map((slice) => slice.files.filter((f) => !isHotspot(f, hotspots)));
  const sharedCount = (a: number, b: number) =>
    (ownFiles[a] as string[]).filter((fa) =>
      (ownFiles[b] as string[]).some((fb) => pathsOverlap(fa, fb)),
    ).length;
  const predecessors = (i: number) => needs.filter(([, t]) => t === i).map(([s]) => s);

  const graph = new CohortGraph(
    new Set(slices.flatMap((slice) => (slice.cohort === undefined ? [] : [slice.cohort]))),
  );
  const cohortOf = new Map<number, number>();
  const notes: string[] = [];

  for (const slice of order) {
    const preds = predecessors(slice);
    // Cohorts sharing files with this slice, most shared files first.
    const overlap = new Map<number, number>();
    for (const [other, cohort] of cohortOf) {
      const n = sharedCount(slice, other);
      if (n > 0) overlap.set(cohort, (overlap.get(cohort) ?? 0) + n);
    }
    const candidates = [...overlap.keys()]
      .filter((c) => !graph.assigned[c])
      .sort((a, b) => (overlap.get(b) as number) - (overlap.get(a) as number) || a - b);
    if (input.group_dependencies) {
      for (const p of preds) {
        const c = cohortOf.get(p) as number;
        if (!graph.assigned[c] && !candidates.includes(c)) candidates.push(c);
      }
    }

    const label = (slices[slice] as Slice).cohort;
    let home: number | null = null;
    if (label !== undefined) {
      const existing = graph.indexOf(label);
      home = existing >= 0 ? existing : graph.add(slice, label);
      if (existing >= 0) (graph.members[home] as number[]).push(slice);
      for (const p of preds) {
        const pc = cohortOf.get(p) as number;
        if (pc !== home && graph.reaches(home, pc)) {
          throw planError(
            "COHORT_CYCLE",
            `Cohorts ${label} and ${graph.name(pc)} would each wait for the other: ` +
              `${id(p)} → ${id(slice)} runs against the order between them`,
            { cohorts: [label, graph.name(pc)], needs: [id(p), id(slice)] },
          );
        }
      }
    }
    for (const c of label === undefined ? candidates : []) {
      const members = graph.members[c] as number[];
      if (members.length >= input.max_children) {
        notes.push(
          `${id(slice)} starts its own cohort after ${graph.name(c)} instead of joining it: ` +
            `that cohort is full (max_children ${input.max_children}).`,
        );
        continue;
      }
      // Joining c adds edges pred-cohort → c; that is a cycle if c already reaches one of them.
      const cycle = preds.some((p) => {
        const pc = cohortOf.get(p) as number;
        return pc !== c && graph.reaches(c, pc);
      });
      if (cycle) {
        notes.push(
          `${id(slice)} starts its own cohort after ${graph.name(c)} instead of joining it: ` +
            "joining would order the cohorts both ways.",
        );
        continue;
      }
      home = c;
      break;
    }
    if (home === null) home = graph.add(slice);
    else if (label === undefined) (graph.members[home] as number[]).push(slice);
    cohortOf.set(slice, home);

    for (const p of preds)
      graph.link(cohortOf.get(p) as number, home, "needs", `${id(p)} → ${id(slice)}`);
    for (const c of overlap.keys()) {
      if (c !== home && !graph.ordered(c, home)) {
        const shared = [...cohortOf]
          .filter(([other, oc]) => oc === c && sharedCount(slice, other) > 0)
          .map(([other]) => id(other));
        graph.link(c, home, "overlap", `${shared.join(", ")} ~ ${id(slice)}`);
      }
    }
  }

  const members = graph.members;
  const names = (c: number) => graph.name(c);
  const edgeList = [...graph.edges.values()];
  const cohortIdx = (name: string) => graph.indexOf(name);
  const incoming = members.map(() => [] as number[]);
  for (const edge of edgeList) {
    (incoming[cohortIdx(edge.target)] as number[]).push(cohortIdx(edge.source));
  }
  const childEdges = members.map(() => [] as [string, string][]);
  for (const [s, t] of needs) {
    if (cohortOf.get(s) === cohortOf.get(t)) {
      (childEdges[cohortOf.get(s) as number] as [string, string][]).push([id(s), id(t)]);
    }
  }

  const runs = members.map((m) => (m.length === 1 ? 1 : m.length + 1));
  const cohortOrder = topoOrder(
    members.map((_, c) => c),
    edgeList.map((e) => [cohortIdx(e.source), cohortIdx(e.target)] as [number, number]),
  ) as number[];
  const longest = new Map<number, { runs: number; path: number[] }>();
  for (const c of cohortOrder) {
    let best: { runs: number; path: number[] } = { runs: 0, path: [] };
    for (const p of incoming[c] as number[]) {
      const candidate = longest.get(p) as { runs: number; path: number[] };
      if (candidate.runs > best.runs) best = candidate;
    }
    longest.set(c, { runs: best.runs + (runs[c] as number), path: [...best.path, c] });
  }
  const chain = [...longest.values()].reduce((a, b) => (b.runs > a.runs ? b : a), {
    runs: 0,
    path: [] as number[],
  });

  const hotspotsOf = members.map((m) =>
    hotspots.filter((h) =>
      m.some((i) => (slices[i] as Slice).files.some((f) => pathsOverlap(f, h))),
    ),
  );
  const warnings: CohortWarning[] = [];
  for (const hotspot of hotspots) {
    const touching = members
      .map((_, c) => c)
      .filter((c) => (hotspotsOf[c] as string[]).includes(hotspot));
    const unordered: number[] = [];
    for (const c of touching) if (unordered.every((u) => !graph.ordered(u, c))) unordered.push(c);
    if (unordered.length > 2) {
      warnings.push({
        code: "HOTSPOT_CONCURRENCY",
        hotspot,
        cohorts: unordered.map(names),
        message:
          `${unordered.length} cohorts with no order between them edit ${hotspot}; add root-to-root ` +
          "edges so at most two run at once.",
      });
    }
  }

  const cohorts: Cohort[] = members.map((m, c) => {
    const counts = new Map<string, number>();
    for (const i of m)
      for (const f of ownFiles[i] as string[]) counts.set(f, (counts.get(f) ?? 0) + 1);
    return {
      cohort: names(c),
      slices: m.map(id),
      runs: runs[c] as number,
      blocked_by: [...new Set((incoming[c] as number[]).map(names))].sort(),
      shared_files: [...counts]
        .filter(([, n]) => n > 1)
        .map(([f]) => f)
        .sort(),
      hotspots: hotspotsOf[c] as string[],
      child_edges: childEdges[c] as [string, string][],
    };
  });

  return {
    cohorts,
    edges: edgeList,
    summary: {
      slices: slices.length,
      cohorts: cohorts.length,
      pull_requests: cohorts.length,
      longest_chain_runs: chain.runs,
      longest_chain: chain.path.map(names),
      ready_at_start: cohorts.filter((c) => c.blocked_by.length === 0).map((c) => c.cohort),
    },
    warnings,
    notes,
  };
}
