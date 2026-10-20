import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import pending from "../../contracts/pending/project-readiness.json" with { type: "json" };
import type { components } from "../generated/project-readiness.js";
import type { RunContext } from "./context.js";
import { CliError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import type { ApiRequest, ApiResponse } from "./http.js";
import { schemaIssues, validateBody, type OpenApiDocument } from "./input.js";
import { SYMBOL } from "./prompter.js";
import type { Session } from "./session.js";
import { readTarGz, TarError } from "./tar.js";

/**
 * A Project's readiness: the inspection of its repository, its findings (one per area), the
 * questions it could not answer, the proposed setup under `.pidgen/` and the rehearsal that proves
 * it, and the Project doctor's report on whether the setup is why work fails. `pidgen project
 * inspect`, `project setup`, `project rehearse` and `project doctor` read and render it here.
 *
 * The App Service has agreed these routes but not yet published them, so the CLI is built against
 * a pending fragment, `contracts/pending/project-readiness.json`, its types generated from it and
 * every answer validated against it. When the server publishes them they are pulled with
 * `contracts/openapi.json` and the fragment is deleted.
 */

export type Readiness = components["schemas"]["Readiness"];
export type ReadinessArea = components["schemas"]["ReadinessArea"];
export type ReadinessQuestion = components["schemas"]["ReadinessQuestion"];
export type ReadinessProposal = components["schemas"]["ReadinessProposal"];
export type Rehearsal = components["schemas"]["Rehearsal"];
export type RehearsalStep = components["schemas"]["RehearsalStep"];
export type ReadinessAnswer = components["schemas"]["ReadinessAnswer"];
export type DoctorReport = components["schemas"]["ProjectDoctorReport"];
export type DoctorGroup = components["schemas"]["DoctorGroup"];
export type DoctorCheck = components["schemas"]["DoctorCheck"];
export type DoctorRequest = components["schemas"]["ProjectDoctorRequest"];

/** The pending fragment, bundled into the CLI at build time. */
export const READINESS_DOCUMENT: OpenApiDocument = pending;

/** Each readiness route, its path template as the fragment names it and the schema it answers. */
export const READINESS_ROUTES = {
  read: { method: "GET", path: "/projects/{project_ref}/readiness", answers: "Readiness" },
  archive: { method: "GET", path: "/projects/{project_ref}/readiness/proposal/archive" },
  pullRequest: {
    method: "POST",
    path: "/projects/{project_ref}/readiness/proposal/pull-request",
    answers: "ReadinessProposal",
  },
  answers: {
    method: "POST",
    path: "/projects/{project_ref}/readiness/answers",
    answers: "Readiness",
  },
  rehearse: {
    method: "POST",
    path: "/projects/{project_ref}/readiness/rehearse",
    answers: "Rehearsal",
  },
  doctor: {
    method: "POST",
    path: "/projects/{project_ref}/readiness/doctor",
    answers: "ProjectDoctorReport",
  },
} as const;

/** A readiness route answered in JSON, and the fragment's schema for its `data`. */
interface JsonRoute {
  method: "GET" | "POST";
  path: string;
  answers: string;
}

/** The archive's media type. */
export const ARCHIVE_TYPE = "application/gzip";

/** How often a followed rehearsal is read again, and for how long at most. */
export const REHEARSAL_POLL_MS = 2000;
export const REHEARSAL_FOLLOW_LIMIT_MS = 30 * 60 * 1000;

const SETTLED = new Set<Rehearsal["state"]>(["passed", "failed", "cancelled"]);

function routePath(route: { path: string }, key: string): string {
  return route.path.replace("{project_ref}", key);
}

/**
 * Sends one JSON readiness route for the Project `key` (a checked, percent-encoded segment) and
 * validates its `data` against the fragment: one that does not match is `UNEXPECTED_RESPONSE`
 * (exit 1). A request body is validated before it is sent (`INPUT_INVALID`, exit 2).
 */
export async function sendReadiness<T>(
  session: Session,
  route: JsonRoute,
  key: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const request: ApiRequest = { method: route.method, path: routePath(route, key) };
  if (body !== undefined) {
    request.body = validateBody(READINESS_DOCUMENT, route.method, route.path, body);
  }
  const response = await session.client.request<unknown>(request);
  const issues = schemaIssues(
    READINESS_DOCUMENT,
    { $ref: `#/components/schemas/${route.answers}` },
    response.data,
  );
  if (issues.length > 0) {
    throw new CliError(
      "UNEXPECTED_RESPONSE",
      `The server's ${route.answers} does not match the contract (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,
      ExitCode.Unexpected,
      { route: `${route.method} /api/v1${route.path}`, issues },
    );
  }
  return response as ApiResponse<T>;
}

/** `GET /projects/{key}/readiness`, validated. */
export function readReadiness(session: Session, key: string): Promise<ApiResponse<Readiness>> {
  return sendReadiness<Readiness>(session, READINESS_ROUTES.read, key);
}

// ── Rendering ──────────────────────────────────────────────────────────────────────────────────

const STATE_WORDS: Record<ReadinessArea["state"], string> = {
  ok: "ok",
  proposed: "proposed",
  needs_you: "needs you",
  cannot_tell: "cannot tell",
  pending: "pending",
};

/** The word the report shows for a finding's state. */
export function stateWord(state: ReadinessArea["state"]): string {
  return STATE_WORDS[state] ?? String(state).replaceAll("_", " ");
}

function shortCommit(commit: string | null | undefined): string {
  return commit ? commit.slice(0, 7) : "";
}

function inspectionLine(readiness: Readiness): string {
  const inspection = readiness.inspection;
  const repository = readiness.repository ?? "the repository";
  if (inspection === null) return "Not inspected yet.";
  const at = `${repository} at ${inspection.ref}`;
  const commit = inspection.commit ? ` (${shortCommit(inspection.commit)})` : "";
  const through = inspection.source === "forge" ? "through the forge" : "by a worker";
  switch (inspection.state) {
    case "inspecting":
      return `Inspecting ${at}${commit} ${through}; this report fills in on its own.`;
    case "failed":
      return `Could not read ${at}: ${inspection.failure ?? "no reason given"}.`;
    default:
      return `Read ${at}${commit} ${through}.`;
  }
}

/** The questions still waiting for an answer. */
export function openQuestions(readiness: Readiness): ReadinessQuestion[] {
  return readiness.questions.filter((question) => question.answer === null);
}

/** The `--answer` that answers `question`, with its choices as the placeholder. */
export function answerCommand(key: string, question: ReadinessQuestion): string {
  const placeholder = question.choices.length > 0 ? question.choices.join("|") : "answer";
  return `pidgen project inspect ${key} --answer ${question.question_id}=<${placeholder}>`;
}

/**
 * The inspection report a terminal shows: the Project and what was read, one row per area (its
 * state word, its name and its summary, with what is proposed or needed beneath), then the open
 * questions with the `--answer` that answers each and inspects again, then the proposal and the
 * latest rehearsal.
 */
export function renderReadiness(readiness: Readiness): string {
  const key = readiness.project_key;
  const lines = [`${readiness.project_name} (${key})`, inspectionLine(readiness), ""];
  if (readiness.areas.length > 0) {
    const wordWidth = Math.max(...readiness.areas.map((area) => stateWord(area.state).length));
    const titleWidth = Math.max(...readiness.areas.map((area) => area.title.length));
    const indent = " ".repeat(2 + wordWidth + 2 + titleWidth + 2);
    for (const area of readiness.areas) {
      lines.push(
        `  ${stateWord(area.state).padEnd(wordWidth)}  ${area.title.padEnd(titleWidth)}  ${area.summary}`,
      );
      if (area.proposal) lines.push(`${indent}Proposed: ${area.proposal}`);
      if (area.ask) lines.push(`${indent}Needs you: ${area.ask}`);
    }
  } else {
    lines.push("  No findings yet.");
  }
  const open = openQuestions(readiness);
  if (open.length > 0) {
    lines.push("", "Open questions");
    for (const question of open) {
      lines.push(`  ${question.question_id}: ${question.question}`);
      for (const evidence of question.evidence) lines.push(`    Found: ${evidence}`);
      if (question.default !== null) lines.push(`    Default: ${question.default}`);
      lines.push(`    Answer and inspect again: ${answerCommand(key, question)}`);
    }
  }
  lines.push("", ...proposalLines(readiness));
  if (readiness.rehearsal !== null) {
    lines.push(`Last rehearsal: ${verdictLine(readiness.rehearsal)}`);
  }
  return lines.join("\n") + "\n";
}

function proposalLines(readiness: Readiness): string[] {
  const key = readiness.project_key;
  const proposal = readiness.proposal;
  if (proposal === null) {
    return readiness.inspection?.state === "inspecting"
      ? ["The proposed setup follows the findings."]
      : ["Nothing is proposed."];
  }
  const files = `${proposal.files.length} file${proposal.files.length === 1 ? "" : "s"}`;
  if (proposal.pull_request !== null && proposal.state === "pull_request_open") {
    return [
      `Proposed setup: ${files} in pull request #${proposal.pull_request.number}, ${proposal.pull_request.url}`,
      `Rehearse it: pidgen project rehearse ${key}`,
    ];
  }
  if (proposal.state === "merged") return [`Setup merged: ${files} under .pidgen/.`];
  return [`Proposed setup: ${files}, a draft. Review it: pidgen project setup ${key}`];
}

/** `pidgen project setup <key>` without flags: the proposed files and how to write them. */
export function renderProposal(readiness: Readiness, proposal: ReadinessProposal): string {
  const key = readiness.project_key;
  const files = `${proposal.files.length} file${proposal.files.length === 1 ? "" : "s"}`;
  const state =
    proposal.state === "draft"
      ? "a draft"
      : proposal.state === "merged"
        ? "merged"
        : "in a pull request";
  const lines = [`Proposed setup for ${readiness.project_name} (${key}): ${files}, ${state}`];
  const width = Math.max(0, ...proposal.files.map((file) => file.path.length));
  for (const file of proposal.files) {
    lines.push(`  ${file.executable ? file.path.padEnd(width) + "  executable" : file.path}`);
  }
  if (proposal.assumptions.length > 0) {
    lines.push("It assumes:", ...proposal.assumptions.map((assumption) => `  - ${assumption}`));
  }
  const open = openQuestions(readiness);
  if (open.length > 0) {
    lines.push(
      `${open.length} question${open.length === 1 ? " is" : "s are"} open: pidgen project inspect ${key}`,
    );
  }
  if (proposal.pull_request !== null) {
    lines.push(
      `Pull request #${proposal.pull_request.number} (${proposal.pull_request.state}): ${proposal.pull_request.url}`,
    );
  }
  lines.push(
    `Write them in this checkout: pidgen project setup ${key} --write`,
    `Or open the pull request:    pidgen project setup ${key} --pull-request`,
  );
  return lines.join("\n") + "\n";
}

/** `--pull-request`: the pull request and what to do next. */
export function renderPullRequest(key: string, proposal: ReadinessProposal): string {
  const pr = proposal.pull_request;
  if (pr === null) return `No pull request is open for ${key}.\n`;
  return (
    `Pull request #${pr.number} (${pr.state}) on branch ${pr.branch}: ${pr.url}\n` +
    `Rehearse it before you merge: pidgen project rehearse ${key}\n`
  );
}

/** A duration as `m:ss`, or `h:mm:ss` from an hour. */
export function clock(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** One reported step: its name, state and time, a nonzero exit status, and what it said. */
export function renderStep(step: RehearsalStep): string {
  const parts = [step.step.padEnd(10), step.state.padEnd(7)];
  if (step.duration_seconds !== null) parts.push(clock(step.duration_seconds).padStart(5));
  if (step.exit_code !== null && step.exit_code !== 0) parts.push(`exit ${step.exit_code}`);
  if (step.summary) parts.push(step.summary);
  return parts.join("  ").trimEnd();
}

function verdictLine(rehearsal: Rehearsal): string {
  const where = [
    rehearsal.worker ? `on ${rehearsal.worker}` : "",
    `from ${rehearsal.ref}${rehearsal.commit ? ` (${shortCommit(rehearsal.commit)})` : ""}`,
  ]
    .filter(Boolean)
    .join(" ");
  const verdict = rehearsal.verdict ? `: ${rehearsal.verdict}` : ".";
  return `${rehearsal.state} ${where}${verdict}`;
}

/** The rehearsal's verdict, the last thing `pidgen project rehearse` prints. */
export function renderVerdict(rehearsal: Rehearsal, key: string): string {
  const head = SETTLED.has(rehearsal.state)
    ? `Rehearsal ${verdictLine(rehearsal)}`
    : `Rehearsal ${rehearsal.rehearsal_id} is ${verdictLine(rehearsal)} Follow it: pidgen project inspect ${key}`;
  const log = rehearsal.log_artifact_id ? `\nLog: artifact ${rehearsal.log_artifact_id}` : "";
  return `${head}${log}\n`;
}

// ── The Project doctor ─────────────────────────────────────────────────────────────────────────

/** clack's symbols for a check's state, as `pidgen setup` draws them. */
const DOCTOR_SYMBOLS: Record<DoctorCheck["state"], string> = {
  ok: SYMBOL.submit,
  needs_you: SYMBOL.warn,
  failed: SYMBOL.cancel,
};

const DOCTOR_RANK: Record<DoctorCheck["state"], number> = { ok: 0, needs_you: 1, failed: 2 };

/** A group's state: its worst check's. */
export function groupState(group: DoctorGroup): DoctorCheck["state"] {
  return group.checks.reduce<DoctorCheck["state"]>(
    (worst, check) => (DOCTOR_RANK[check.state] > DOCTOR_RANK[worst] ? check.state : worst),
    "ok",
  );
}

/** The verdict line: only `setup` blames the setup, and only it makes the command exit 1. */
const DOCTOR_VERDICTS: Record<DoctorReport["verdict"], string> = {
  setup: "The setup is the problem.",
  code: "The setup is not the problem.",
  unclear: "The doctor cannot tell whether the setup is the problem.",
};

/** How `pidgen project doctor` was asked, for the commands its report names. */
export interface DoctorAsked {
  /** `--since` as given, repeated in the `--propose-fix` command. */
  since?: string;
  /** Whether `--propose-fix` was given. */
  proposeFix: boolean;
}

/**
 * The doctor's report as a terminal shows it, the CLI transcript of the Project page wireframe:
 * the frame's title; one line per group, its worst check's symbol (`◇` ok, `▲` needs you, `■`
 * failed), its title and the summaries of its checks that are not ok (all of them when every one
 * is); beneath a check that is not ok, what the failure said with its Tickets by key, the change
 * that introduced it and the fix; then the verdict line, its sentence, and the commands to run
 * next (the fix, the Tickets to retry or open, and the rehearsal), each with what it does.
 */
export function renderDoctor(report: DoctorReport, asked: DoctorAsked): string {
  const key = report.project_key;
  const lines = [
    `${SYMBOL.start}  Pidgen project doctor · ${report.project_name} (${key})`,
    SYMBOL.bar,
  ];
  for (const group of report.groups) {
    const state = groupState(group);
    const shown = state === "ok" ? group.checks : group.checks.filter((c) => c.state !== "ok");
    lines.push(
      `${DOCTOR_SYMBOLS[state]}  ${[group.title, ...shown.map((c) => c.summary)].join(" · ")}`,
    );
    for (const check of shown) {
      if (check.state === "ok") continue;
      const tickets = check.tickets.join(", ");
      if (check.evidence !== null) {
        lines.push(`${SYMBOL.bar}  "${check.evidence}"${tickets ? ` — ${tickets}` : ""}`);
      } else if (tickets && !check.summary.includes(check.tickets[0]!)) {
        lines.push(`${SYMBOL.bar}  ${tickets}`);
      }
      if (check.cause !== null) lines.push(`${SYMBOL.bar}  ${check.cause}`);
      if (check.fix !== null) lines.push(`${SYMBOL.bar}  ${check.fix}`);
    }
  }
  lines.push(
    SYMBOL.bar,
    `${SYMBOL.end}  ${DOCTOR_VERDICTS[report.verdict]}`,
    `   ${report.summary}`,
    ...nextLines(report, asked),
  );
  return lines.join("\n") + "\n";
}

/** `Fix:`, `Then:`, `Open:` and `Also:`, each command or step with what it does after `#`. */
function nextLines(report: DoctorReport, asked: DoctorAsked): string[] {
  const key = report.project_key;
  const rows: [label: string, step: string, note: string][] = [];
  const and = (keys: string[], tail = "") =>
    keys.length > 1 ? `and ${keys.slice(1).join(", ")}${tail ? `, ${tail}` : ""}` : tail;
  const fix = report.fix;
  if (report.verdict === "setup" && fix !== null) {
    const pr = fix.pull_request;
    if (pr !== null) {
      rows.push(["Fix", `pull request #${pr.number} (${pr.state}), ${pr.url}`, "merge it"]);
    } else if (fix.template !== null) {
      const since = asked.since === undefined ? "" : ` --since ${asked.since}`;
      rows.push([
        "Fix",
        `pidgen project doctor ${key}${since} --propose-fix`,
        `opens a pull request: "${fix.summary}"`,
      ]);
    } else {
      rows.push([
        "Fix",
        fix.summary,
        asked.proposeFix ? "no pull request: the doctor has no template for this fix" : "",
      ]);
    }
    if (fix.retry.length > 0) {
      rows.push([
        "Then",
        `pidgen ticket act ${fix.retry[0]} retry_run`,
        and(fix.retry, `once the fix is on ${report.ref}`),
      ]);
    }
  } else if (report.verdict !== "setup" && report.failed_tickets.length > 0) {
    rows.push([
      "Open",
      `pidgen ticket show ${report.failed_tickets[0]}`,
      and(report.failed_tickets),
    ]);
  }
  if (report.rehearse !== null) {
    rows.push(["Also", `pidgen project rehearse ${key}`, report.rehearse]);
  }
  const labelWidth = Math.max(0, ...rows.map(([label]) => label.length + 1));
  const stepWidth = Math.max(0, ...rows.map(([, step]) => step.length));
  return rows.map(([label, step, note]) =>
    `   ${`${label}:`.padEnd(labelWidth)}  ${note ? `${step.padEnd(stepWidth)}  # ${note}` : step}`.trimEnd(),
  );
}

// ── Following a rehearsal ──────────────────────────────────────────────────────────────────────

/** Whether a rehearsal has settled (passed, failed or cancelled). */
export function settled(rehearsal: Rehearsal): boolean {
  return SETTLED.has(rehearsal.state);
}

/**
 * Follows `requested` by reading the Project's readiness every `REHEARSAL_POLL_MS` until its
 * rehearsal settles, calling `report` once for each step as it is reported settled, in order.
 * Returns the settled rehearsal and the last answer read. A rehearsal that no longer is the
 * Project's latest is `REHEARSAL_SUPERSEDED` (exit 1); one still running after
 * `REHEARSAL_FOLLOW_LIMIT_MS` is `TIMEOUT` (exit 8), left running.
 */
export async function followRehearsal(
  ctx: RunContext,
  session: Session,
  key: string,
  requested: Rehearsal,
  report: (step: RehearsalStep) => void,
): Promise<{ rehearsal: Rehearsal; response: ApiResponse<Readiness> | null }> {
  let reported = 0;
  const reportNew = (rehearsal: Rehearsal) => {
    while (reported < rehearsal.steps.length && rehearsal.steps[reported]!.state !== "running") {
      report(rehearsal.steps[reported]!);
      reported++;
    }
  };
  let current = requested;
  let response: ApiResponse<Readiness> | null = null;
  reportNew(current);
  const deadline = ctx.now() + REHEARSAL_FOLLOW_LIMIT_MS;
  while (!settled(current)) {
    if (ctx.now() >= deadline) {
      throw new CliError(
        "TIMEOUT",
        `Rehearsal ${requested.rehearsal_id} is still ${current.state} after ${clock(REHEARSAL_FOLLOW_LIMIT_MS / 1000)}; it goes on without the CLI.`,
        ExitCode.Network,
        { rehearsal: current, next: `pidgen project inspect ${key}` },
      );
    }
    await ctx.sleep(REHEARSAL_POLL_MS);
    response = await readReadiness(session, key);
    const latest = response.data.rehearsal;
    if (latest === null || latest.rehearsal_id !== requested.rehearsal_id) {
      throw new CliError(
        "REHEARSAL_SUPERSEDED",
        `Rehearsal ${requested.rehearsal_id} is no longer the Project's latest.`,
        ExitCode.Unexpected,
        { rehearsal_id: requested.rehearsal_id, latest, next: `pidgen project inspect ${key}` },
      );
    }
    current = latest;
    reportNew(current);
  }
  // A step reported running when the rehearsal settled is reported as it ended.
  for (; reported < current.steps.length; reported++) report(current.steps[reported]!);
  return { rehearsal: current, response };
}

// ── Writing the proposal ───────────────────────────────────────────────────────────────────────

/** What `--write` did to one file. */
export interface WrittenFile {
  path: string;
  executable: boolean;
  status: "created" | "updated" | "unchanged";
}

/**
 * The root of the git checkout holding `cwd`: the nearest directory whose `.git` is a git
 * directory (holding `HEAD`) or, in a worktree, a `gitdir:` file. None is `NOT_A_CHECKOUT`
 * (exit 2).
 */
export async function checkoutRoot(cwd: string): Promise<string> {
  for (let directory = cwd; ; directory = dirname(directory)) {
    if (await isGitEntry(join(directory, ".git"))) return directory;
    if (dirname(directory) === directory) break;
  }
  throw new CliError(
    "NOT_A_CHECKOUT",
    `${cwd} is not in a git checkout; run this in a checkout of the project's repository.`,
    ExitCode.Usage,
    { cwd },
  );
}

async function isGitEntry(path: string): Promise<boolean> {
  const found = await lstat(path).catch(() => null);
  if (found === null) return false;
  if (found.isDirectory()) return (await lstat(join(path, "HEAD")).catch(() => null)) !== null;
  if (!found.isFile()) return false;
  return (await readFile(path, "utf8").catch(() => "")).startsWith("gitdir:");
}

function archiveInvalid(message: string, details: Record<string, unknown> = {}): CliError {
  return new CliError(
    "ARCHIVE_INVALID",
    `The proposed setup's archive cannot be written: ${message}`,
    ExitCode.Unexpected,
    details,
  );
}

/** A path the archive names, checked to stay under `.pidgen/`: relative, no `.` or `..` parts. */
function proposalPath(raw: string, directory = false): string {
  let path = raw.replace(/^(\.\/)+/, "");
  if (directory) path = path.replace(/\/+$/, "");
  const parts = path.split("/");
  const inside =
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    parts.every((part) => part !== "" && part !== "." && part !== "..") &&
    parts[0] === ".pidgen" &&
    (directory || parts.length > 1);
  if (!inside) throw archiveInvalid(`${JSON.stringify(raw)} is not a path under .pidgen/.`);
  return path;
}

/**
 * Extracts the proposal archive `bytes` under `.pidgen/` in the checkout at `root`, a script with
 * mode 0755 and every other file 0644, as the archive's executable bits say. Everything is checked
 * before anything is written: an archive that is not a gzip tar, names a path outside `.pidgen/`,
 * or holds a link is `ARCHIVE_INVALID` (exit 1); an existing `.pidgen/` that the write would
 * change at all (a file created in it, replaced, or given another mode) is `FILES_EXIST` (exit 5)
 * unless `force`, so writing the same proposal again changes nothing and succeeds; a symbolic link
 * or a non-directory where a directory goes is `UNSAFE_PATH` (exit 5). Files of its own under
 * `.pidgen/` that the proposal does not name are left as they are, even with `force`.
 */
export async function writeProposal(
  root: string,
  bytes: Uint8Array,
  { force, key }: { force: boolean; key: string },
): Promise<WrittenFile[]> {
  let archive;
  try {
    archive = readTarGz(bytes);
  } catch (error) {
    if (error instanceof TarError) throw archiveInvalid(error.message);
    throw error;
  }
  for (const directory of archive.directories) proposalPath(directory, true);
  const files = archive.files
    .map((file) => ({
      ...file,
      path: proposalPath(file.path),
      executable: (file.mode & 0o111) !== 0,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (files.length === 0) throw archiveInvalid("it holds no files.");
  const duplicate = files.find((file, index) => index > 0 && files[index - 1]!.path === file.path);
  if (duplicate) throw archiveInvalid(`it names ${duplicate.path} twice.`);

  const planned: Array<(typeof files)[number] & { status: WrittenFile["status"] }> = [];
  for (const file of files) {
    const parts = file.path.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const directory = join(root, ...parts.slice(0, depth));
      const found = await lstat(directory).catch(() => null);
      if (found !== null && (found.isSymbolicLink() || !found.isDirectory())) {
        throw unsafePath(parts.slice(0, depth).join("/"), "is not a directory");
      }
    }
    const target = join(root, file.path);
    const found = await lstat(target).catch(() => null);
    if (found === null) {
      planned.push({ ...file, status: "created" });
      continue;
    }
    if (found.isSymbolicLink() || !found.isFile()) throw unsafePath(file.path, "is not a file");
    const same = Buffer.from(await readFile(target)).equals(Buffer.from(file.content));
    const sameMode = (found.mode & 0o777) === (file.executable ? 0o755 : 0o644);
    planned.push({ ...file, status: same && sameMode ? "unchanged" : "updated" });
  }
  const existing = await lstat(join(root, ".pidgen")).catch(() => null);
  const changes = planned.filter((file) => file.status !== "unchanged").map((file) => file.path);
  if (existing !== null && changes.length > 0 && !force) {
    throw new CliError(
      "FILES_EXIST",
      `.pidgen/ already exists in ${root}, and writing the proposal would change ${changes.length === 1 ? "1 file" : `${changes.length} files`} in it: ${changes.join(", ")}. Nothing was written.`,
      ExitCode.Refused,
      { root, paths: changes, next: `pidgen project setup ${key} --write --force` },
    );
  }
  for (const file of planned) {
    if (file.status === "unchanged") continue;
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
    await chmod(target, file.executable ? 0o755 : 0o644);
  }
  return planned.map(({ path, executable, status }) => ({ path, executable, status }));
}

function unsafePath(path: string, why: string): CliError {
  return new CliError(
    "UNSAFE_PATH",
    `${path} ${why}; nothing was written. Move it aside and write the setup again.`,
    ExitCode.Refused,
    { path },
  );
}

/** `--write`: where the files went and what to do next. */
export function renderWritten(key: string, root: string, files: WrittenFile[]): string {
  const count = (status: WrittenFile["status"]) =>
    files.filter((file) => file.status === status).length;
  const summary = (["created", "updated", "unchanged"] as const)
    .map((status) => [count(status), status] as const)
    .filter(([n]) => n > 0)
    .map(([n, status]) => `${n} ${status}`)
    .join(", ");
  const width = Math.max(...files.map((file) => file.status.length));
  return [
    `The proposed setup is under .pidgen/ in ${root}: ${summary}.`,
    ...files.map(
      (file) =>
        `  ${file.status.padEnd(width)}  ${file.path}${file.executable ? "  (executable)" : ""}`,
    ),
    `Commit and push them, then rehearse the branch: pidgen project rehearse ${key} --ref <branch>`,
    "",
  ].join("\n");
}
