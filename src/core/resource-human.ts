import { FAILURE_ACTORS, readFailure, ticketFailure, type FailureProjection } from "./failure.js";

/** Read presentations operate on views only; response data remains untouched for JSON. */
interface ReadPresentation {
  title: string;
  compact?: boolean;
}

/** Explicit resource-read surface; other command families keep their own presentation. */
export const READ_PRESENTATIONS: Readonly<Record<string, ReadPresentation>> = {
  "project list": { title: "Projects", compact: true },
  "project show": { title: "Project" },
  "domain list": { title: "Domains", compact: true },
  "domain show": { title: "Domain" },
  "domain epics": { title: "Initiatives" },
  "contract list": { title: "Contracts" },
  "contract show": { title: "Contract" },
  "ticket list": { title: "Tickets", compact: true },
  "ticket show": { title: "Ticket" },
  "ticket types": { title: "Workflow types", compact: true },
  "ticket dep list": { title: "Ticket dependencies" },
  "ticket actions": { title: "Ticket actions" },
  "ticket history": { title: "Ticket history" },
  "ticket instructions": { title: "Ticket instructions" },
  "epic list": { title: "Epics", compact: true },
  "epic show": { title: "Epic" },
  "epic dag show": { title: "Epic dependency graph" },
  "intent list": { title: "Intents", compact: true },
  "intent show": { title: "Intent" },
  "request list": { title: "Requests", compact: true },
  "request show": { title: "Request" },
  "plan show": { title: "Child plan" },
  "plan cohorts": { title: "Cohort plan" },
  "run list": { title: "Runs", compact: true },
  "run show": { title: "Run" },
  "run node-output": { title: "Node output" },
  "review list": { title: "Review tickets", compact: true },
  "review attention": { title: "Attention queue" },
  "session instructions": { title: "Session instructions" },
  "api get": { title: "API response", compact: true },
};

type Row = Record<string, unknown>;

/** Full, labeled detail view shared by resource and mutation presentations. */
export function renderDetails(data: unknown, columns = 80): string {
  const width = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;
  return detail(data, width, 0);
}

export function renderResourceRead(
  command: string,
  data: unknown,
  columns = 80,
): string | undefined {
  const presentation = READ_PRESENTATIONS[command];
  if (!presentation) return undefined;
  const width = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;
  if (command === "ticket types" && Array.isArray(data) && data.some(describesWhenToUse)) {
    return workflowTypes(presentation.title, data, width) + "\n";
  }
  if (Array.isArray(data)) {
    return collection(presentation.title, data, width, 0, presentation.compact === true) + "\n";
  }
  let body: string;
  if (command === "contract list" && isRecord(data)) {
    body = contractCollections(data, width);
  } else if (command === "domain epics" && isRecord(data)) {
    body = domainBoard(data, width);
  } else if (command === "ticket show" && isRecord(data) && ticketFailure(data) !== undefined) {
    body = ticketWithFailure(data, width);
  } else if (command === "ticket actions" && isRecord(data) && readFailure(data["failure"])) {
    body = actionsWithFailure(data, width);
  } else {
    body = detail(data, width, 0);
  }
  return `${presentation.title}\n${body}\n`;
}

function label(key: string): string {
  const words = key.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return value === "" ? "(empty string)" : String(value);
}

/** Wrap words, never split a token. Explicit line breaks and indentation stay intact. */
export function wrap(text: string, width: number): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.length <= width) return line;
      const indent = /^\s*/.exec(line)?.[0] ?? "";
      const words = line.slice(indent.length).split(/\s+/);
      const lines: string[] = [];
      let current = indent;
      for (const word of words) {
        if (current.length > indent.length && current.length + word.length + 1 > width) {
          lines.push(current);
          current = indent;
        }
        current += (current.length > indent.length ? " " : "") + word;
      }
      lines.push(current);
      return lines.join("\n");
    })
    .join("\n");
}

function literalText(text: string): boolean {
  return (
    text.includes("\n") ||
    /(?:^|\n)\s*(?:\$ )?pidgen\s/.test(text) ||
    /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE) \//.test(text)
  );
}

/** A collection's field name carries the same copyability requirement as a scalar field. */
function literalField(key: string): boolean {
  return /(?:^|_)(?:digests?|paths?|files?|handles?|urls?|acknowledgements?|commands?|recovery|schema|markdown|codes?|keys?|ids?)(?:$|_)/.test(
    key,
  );
}

function pad(text: string, indent: number): string {
  return text
    .split("\n")
    .map((line) => " ".repeat(indent) + line)
    .join("\n");
}

function field(key: string, value: unknown, width: number, indent: number): string {
  const name = label(key);
  if (Array.isArray(value)) return collection(name, value, width, indent, false, literalField(key));
  if (isRecord(value)) return `${pad(name + ":", indent)}\n${detail(value, width, indent + 2)}`;
  const text = scalar(value);
  const prefix = `${name}: `;
  // Text blocks, schemas, and executable commands retain their original line structure.
  const literal = literalText(text) || literalField(key);
  if (!text.includes("\n") && prefix.length + text.length <= width - indent) {
    return pad(prefix + text, indent);
  }
  const content = literal ? text : wrap(text, Math.max(1, width - indent - 2));
  return `${pad(name + ":", indent)}\n${pad(content, indent + 2)}`;
}

function detail(value: unknown, width: number, indent: number): string {
  if (Array.isArray(value)) return collection("Results", value, width, indent);
  if (!isRecord(value)) {
    const text = scalar(value);
    return pad(literalText(text) ? text : wrap(text, Math.max(1, width - indent)), indent);
  }
  const entries = Object.entries(value);
  if (!entries.length) return pad("No data (empty object).", indent);
  return entries.map(([key, item]) => field(key, item, width, indent)).join("\n");
}

/** Only identifying and state fields belong in a list; full nested records belong in show. */
function compactRow(row: Row): Row {
  const identity =
    /^(?:id|key|.*_key|title|name|label|prefix|slug|request_id|conversation_id|instruction_id|workflow_run_id|node_id|cohort|workflow_name|workflow_type|kind|type|stage|state|status|priority|implemented|ready|archived|builtin|default|delivery_mode|status_label|waiting_on_requester|attempt_number|attempt_count|newest_accepted_revision|.*_count|(?:.*_)?(?:path|digest|code|acknowledgement|command|recovery))$/;
  const projected = Object.fromEntries(
    Object.entries(row).filter(
      ([key, value]) => identity.test(key) && !isRecord(value) && !Array.isArray(value),
    ),
  );
  for (const key of ["provider", "project", "epic", "liveness", "target"]) {
    const nested = row[key];
    if (isRecord(nested)) {
      projected[key] = Object.entries(nested)
        .filter(
          ([name, value]) =>
            (identity.test(name) || name.endsWith("_id")) &&
            value !== null &&
            typeof value !== "object",
        )
        .map(([, value]) => scalar(value))
        .join(" / ");
    }
  }
  // Qualifications belong beside the result even in a compact list.
  for (const key of ["warnings", "warning", "unreachable", "contract", "unchecked"]) {
    if (key in row) projected[key] = row[key];
  }
  if (!Object.keys(projected).length) {
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        Array.isArray(value)
          ? `${value.length} records`
          : isRecord(value)
            ? `${Object.keys(value).length} fields`
            : value,
      ]),
    );
  }
  return projected;
}

function collection(
  title: string,
  rows: unknown[],
  width: number,
  indent: number,
  compact = false,
  literalValues = false,
): string {
  const heading = `${title} (${rows.length} displayed)`;
  if (!rows.length)
    return pad(wrap(heading + ": No results.", Math.max(1, width - indent)), indent);
  const views = compact ? rows.map((row) => (isRecord(row) ? compactRow(row) : row)) : rows;
  if (compact && views.every(isRecord)) {
    const table = compactTable(views, width - indent);
    if (table) return `${pad(heading, indent)}\n${pad(table, indent)}`;
  }
  return (
    `${pad(heading, indent)}\n` +
    views
      .map((row, index) => {
        // A numbered boundary keeps nested sections attached to their owning record at any width.
        if (isRecord(row) || Array.isArray(row)) {
          return `${pad(`[${index + 1}]`, indent)}\n${detail(row, width, indent + 2)}`;
        }
        const prefix = `[${index + 1}] `;
        const text = scalar(row);
        const content =
          literalValues || literalText(text)
            ? text
            : wrap(text, Math.max(1, width - indent - prefix.length));
        return pad(prefix + content.replaceAll("\n", "\n" + " ".repeat(prefix.length)), indent);
      })
      .join("\n")
  );
}

function compactTable(rows: Row[], width: number, columns?: string[]): string | undefined {
  const keys = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (!keys.length) return undefined;
  if (
    rows.some((row) => Object.values(row).some((value) => isRecord(value) || Array.isArray(value)))
  )
    return undefined;
  const cells = rows.map((row) => keys.map((key) => (key in row ? scalar(row[key]) : "")));
  if (cells.some((row) => row.some((cell) => cell.includes("\n")))) return undefined;
  const widths = keys.map((key, i) =>
    Math.max(label(key).length, ...cells.map((row) => row[i]?.length ?? 0)),
  );
  if (widths.reduce((sum, value) => sum + value, 0) + 2 * (keys.length - 1) > width)
    return undefined;
  const line = (row: string[]) =>
    row
      .map((value, i) => value.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(keys.map(label)), ...cells.map(line)].join("\n");
}

/** The workflow types' own columns, after the compact ones: the workflow's title, then When to use. */
const WORKFLOW_TYPE_TEXT = ["workflow_title", "when_to_use"] as const;

/** The longest When to use a list shows, and the shortest a table cuts it to. */
const WHEN_TO_USE_MAX = 60;
const WHEN_TO_USE_MIN = 20;

function describesWhenToUse(row: unknown): boolean {
  return isRecord(row) && WORKFLOW_TYPE_TEXT.some((key) => key in row);
}

/** `text` on one line, cut to `limit` characters ending in an ellipsis when longer. */
function shorten(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * A workflow type's compact view: its identifying fields, its workflow's title and its When to use
 * cut to `limit` characters. A field the type has none of (null) is left out, so it shows empty.
 */
function workflowTypeView(row: Row, limit: number): Row {
  const rest = Object.fromEntries(
    Object.entries(row).filter(([key]) => !(WORKFLOW_TYPE_TEXT as readonly string[]).includes(key)),
  );
  const view = compactRow(rest);
  const title = row["workflow_title"];
  if (typeof title === "string" && title !== "") view["workflow_title"] = title;
  const when = row["when_to_use"];
  if (typeof when === "string" && when.trim() !== "" && limit > 0) {
    view["when_to_use"] = shorten(when, limit);
  }
  return view;
}

/**
 * The workflow types as a table whose last column, When to use, is cut to the room the terminal
 * leaves it (between WHEN_TO_USE_MIN and WHEN_TO_USE_MAX characters). When even that does not fit,
 * each type is listed on its own with When to use cut to WHEN_TO_USE_MAX. The JSON keeps it whole.
 */
function workflowTypes(title: string, rows: unknown[], width: number): string {
  const views = (limit: number) =>
    rows.map((row) => (isRecord(row) ? workflowTypeView(row, limit) : row));
  const records = (limit: number) => views(limit).filter(isRecord);
  const base = records(0);
  const columns = [
    ...new Set(base.flatMap((row) => Object.keys(row))),
    ...WORKFLOW_TYPE_TEXT,
  ].filter((key, index, all) => all.indexOf(key) === index);
  const heading = `${title} (${rows.length} displayed)`;
  if (rows.every(isRecord)) {
    const without = compactTable(base, Number.POSITIVE_INFINITY, columns.slice(0, -1));
    const used = Math.max(0, ...(without ?? "").split("\n").map((line) => line.length));
    const room = width - used - 2;
    const limit = Math.min(WHEN_TO_USE_MAX, Math.max(WHEN_TO_USE_MIN, room));
    const table = compactTable(records(limit), width, columns);
    if (table) return `${heading}\n${table}`;
  }
  return collection(title, views(WHEN_TO_USE_MAX), width, 0, false);
}

function contractCollections(data: Row, width: number): string {
  return Object.entries(data)
    .map(([key, value]) => {
      if (key === "coverage" && Array.isArray(value)) {
        return collection(
          "Coverage",
          value.map((group) =>
            isRecord(group)
              ? {
                  provider: isRecord(group["provider"])
                    ? compactRow(group["provider"])
                    : group["provider"],
                  contracts: Array.isArray(group["contracts"])
                    ? group["contracts"].map((row: unknown) =>
                        isRecord(row) ? compactRow(row) : row,
                      )
                    : group["contracts"],
                }
              : group,
          ),
          width,
          0,
        );
      }
      return Array.isArray(value)
        ? collection(label(key), value, width, 0, true)
        : field(key, value, width, 0);
    })
    .join("\n");
}

function domainBoard(data: Row, width: number): string {
  return Object.entries(data)
    .map(([key, value]) => {
      if (key === "epics" && Array.isArray(value)) {
        return collection(
          "Initiatives",
          value.map((entry) =>
            isRecord(entry)
              ? {
                  ...entry,
                  epic: isRecord(entry["epic"]) ? compactRow(entry["epic"]) : entry["epic"],
                }
              : entry,
          ),
          width,
          0,
        );
      }
      return key === "tickets" && Array.isArray(value)
        ? collection("Tickets", value, width, 0, true)
        : field(key, value, width, 0);
    })
    .join("\n");
}

/**
 * A failed step in a person's words, from the App Service's failure projection: what happened,
 * what fixes it and who can do it, then the operation, exit status and masked git excerpt under
 * "Technical details".
 */
function failureSection(failure: FailureProjection, width: number): string {
  const parts = [field("failed_step", failure.title, width, 0)];
  if (typeof failure.explanation === "string" && failure.explanation !== "")
    parts.push(field("what_happened", failure.explanation, width, 0));
  if (typeof failure.fix === "string" && failure.fix !== "")
    parts.push(field("fix", failure.fix, width, 0));
  if (typeof failure.actor === "string" && failure.actor !== "")
    parts.push(field("who_can_fix_it", FAILURE_ACTORS[failure.actor] ?? failure.actor, width, 0));
  const technical = failure.technical;
  if (isRecord(technical)) {
    const shown = (["operation", "exit_status", "excerpt"] as const).filter(
      (key) => technical[key] !== undefined && technical[key] !== null,
    );
    if (shown.length) {
      parts.push("Technical details", ...shown.map((key) => field(key, technical[key], width, 2)));
    }
  }
  return parts.join("\n");
}

/** `record` without the `failure` the lead section already shows, so it is not printed twice. */
function withoutFailure(record: unknown, failure: Row): unknown {
  if (!isRecord(record) || record["failure"] !== failure) return record;
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== "failure"));
}

/** A ticket whose step failed: the failure first, then every field as the generic detail shows it. */
function ticketWithFailure(data: Row, width: number): string {
  const failure = ticketFailure(data) as Row;
  const view: Row = { ...data };
  if ("workflow_attention" in view) {
    view["workflow_attention"] = withoutFailure(view["workflow_attention"], failure);
  }
  if (Array.isArray(view["failed_nodes"])) {
    view["failed_nodes"] = view["failed_nodes"].map((node: unknown) =>
      withoutFailure(node, failure),
    );
  }
  return `${failureSection(failure as unknown as FailureProjection, width)}\n${detail(view, width, 0)}`;
}

/**
 * The actions of a ticket whose step failed: the action the projection recommends named first,
 * then the failure, then the decisions with the recommended one leading.
 */
function actionsWithFailure(data: Row, width: number): string {
  const failure = readFailure(data["failure"]) as FailureProjection;
  const kind = failure.recommended_action;
  const view: Row = Object.fromEntries(Object.entries(data).filter(([key]) => key !== "failure"));
  const parts: string[] = [];
  if (typeof kind === "string" && kind !== "") {
    const actions = Array.isArray(data["actions"]) ? data["actions"] : [];
    const recommended = (item: unknown) => isRecord(item) && item["action"] === kind;
    const offered = actions.find(recommended);
    const name =
      isRecord(offered) && typeof offered["label"] === "string" && offered["label"] !== ""
        ? `${offered["label"]} (${kind})`
        : kind;
    parts.push(field("recommended_action", name, width, 0));
    view["actions"] = [
      ...actions.filter(recommended),
      ...actions.filter((item) => !recommended(item)),
    ];
  }
  parts.push(failureSection(failure, width), detail(view, width, 0));
  return parts.join("\n");
}
