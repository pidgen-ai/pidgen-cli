import { renderLifecycle } from "./lifecycle-human.js";
import { renderResourceRead, wrap } from "./resource-human.js";
import { renderMutation } from "./mutation-human.js";

/** Presentation context stays outside response data and metadata. */
export interface PresentationContext {
  command?: readonly string[];
  terminal?: { isTTY: boolean; columns?: number };
  /** HTTP acceptance for direct API calls, outside response data and metadata. */
  responseStatus?: number;
  /** Observation time for human subscription quota ages, outside JSON data. */
  now?: number;
}

/** Shared fallback; command presentations can specialize without modifying JSON results. */
export function renderHuman(data: unknown, context: PresentationContext = {}): string {
  if (context.command?.join(" ") === "skills install" && isInstallation(data)) {
    return renderInstallation(data, context.terminal?.columns);
  }
  const lifecycle = renderLifecycle(
    context.command?.join(" ") ?? "",
    data,
    context.terminal?.columns,
    context.now,
  );
  if (lifecycle !== undefined) return lifecycle;
  const resource = renderResourceRead(
    context.command?.join(" ") ?? "",
    data,
    context.terminal?.columns,
  );
  if (resource !== undefined) return resource;
  const mutation = renderMutation(
    context.command?.join(" ") ?? "",
    data,
    context.terminal?.columns,
    context.responseStatus,
  );
  if (mutation !== undefined) return mutation;
  return describe(data, context.terminal?.columns) + "\n";
}

function describe(data: unknown, columns?: number): string {
  if (data === null || data === undefined) return "Completed (no data).";
  if (Array.isArray(data)) {
    if (data.length === 0) return "No results.";
    if (data.every(isRecord) && data.every((row) => Object.values(row).every(isScalar))) {
      const table = recordsTable(data);
      if (columns === undefined || table.split("\n").every((line) => line.length <= columns)) {
        return table;
      }
    }
    return data
      .map((item, index) => `[${index + 1}] ${indentAfterFirst(describeEntry(item, columns))}`)
      .join("\n");
  }
  if (isRecord(data)) {
    const entries = Object.entries(data);
    if (entries.length === 0) return "No data (empty object).";
    const width = Math.max(...entries.map(([key]) => key.length));
    return entries
      .map(([key, value]) => {
        if (isScalar(value)) return `${key.padEnd(width)}  ${indentAfterFirst(cell(value))}`;
        return `${key}:\n  ${indentAfterFirst(describe(value, columns))}`;
      })
      .join("\n");
  }
  return cell(data);
}

function describeEntry(value: unknown, columns?: number): string {
  return value === null ? "null" : describe(value, columns);
}

function indentAfterFirst(text: string): string {
  return text.replaceAll("\n", "\n  ");
}

function cell(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value === "") return "(empty string)";
  return String(value);
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordsTable(rows: Record<string, unknown>[]): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (columns.length === 0) return rows.map(() => "No data (empty object).").join("\n");
  const cells = rows.map((row) =>
    columns.map((column) => (column in row ? cell(row[column]) : "")),
  );
  const widths = columns.map((column, i) =>
    Math.max(column.length, ...cells.map((line) => (line[i] ?? "").length)),
  );
  const format = (line: string[]) =>
    line
      .map((value, i) => value.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [format(columns.map((key) => key.toUpperCase())), ...cells.map(format)].join("\n");
}

const ACTIONS = ["installed", "updated", "unchanged", "skipped_edited"] as const;
type Action = (typeof ACTIONS)[number];
interface Installation {
  skill: string;
  dir: string;
  agents: string[];
  action: Action;
}

function isInstallation(data: unknown): data is Installation[] {
  return (
    Array.isArray(data) &&
    data.length > 0 &&
    data.every(
      (row: unknown) =>
        isRecord(row) &&
        typeof row["skill"] === "string" &&
        typeof row["dir"] === "string" &&
        Array.isArray(row["agents"]) &&
        row["agents"].every((agent: unknown) => typeof agent === "string") &&
        ACTIONS.includes(row["action"] as Action),
    )
  );
}

function renderInstallation(rows: Installation[], columns = 80): string {
  const width = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;
  const skills = new Set(rows.map((row) => row.skill));
  const agents = new Set(rows.flatMap((row) => row.agents));
  const destinations = new Map<string, Installation[]>();
  for (const row of rows) {
    const entries = destinations.get(row.dir) ?? [];
    entries.push(row);
    destinations.set(row.dir, entries);
  }
  const counts = ACTIONS.map(
    (action) => `${rows.filter((row) => row.action === action).length} ${action.replace("_", " ")}`,
  );
  const sections = [
    wrap(
      `Skills installation: ${skills.size} distinct skills, ${destinations.size} destinations, ${agents.size} agents;\n${rows.length} skill-destination records.\nOutcomes: ${counts.join(", ")}.`,
      width,
    ),
  ];
  for (const [dir, entries] of destinations) {
    const coverage = [...new Set(entries.flatMap((row) => row.agents))];
    const heading = `${dir} (${coverage.join(", ")})`;
    sections.push(
      `${heading.length <= width ? heading : `${dir}\n${wrap(`Agents: ${coverage.join(", ")}`, width)}`}\n${entries.map((row) => `  ${row.skill}: ${row.action.replace("_", " ")}`).join("\n")}`,
    );
  }
  if (rows.some((row) => row.action === "skipped_edited")) {
    sections.push(
      wrap(
        "Skipped locally edited copies were preserved. Use --force only when you intend to overwrite your edits.",
        width,
      ),
    );
  }
  return sections.join("\n\n") + "\n";
}
