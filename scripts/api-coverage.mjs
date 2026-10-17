#!/usr/bin/env node
/**
 * The API coverage report: every operation of the published public API document and the
 * `pidgen` command that calls it, or `—` for none. It is an audit aid for the teams, not user
 * documentation, so it is generated on demand instead of committed:
 *
 *   npm run api:coverage                    # print the report
 *   npm run api:coverage -- --out <file>    # write it to a file
 *
 * When a command starts or stops sending an operation, update COMMAND_OPERATIONS in the same
 * change; tests/scripts/contract-generate.test.ts checks it against the commands and the document.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Each operation a command sends: method, path, and the commands that send it. */
export const COMMAND_OPERATIONS = [
  ["get", "/api/v1/attention", ["pidgen review attention"]],
  ["post", "/api/v1/auth/device", ["pidgen auth login", "pidgen setup"]],
  ["post", "/api/v1/auth/device/token", ["pidgen auth login", "pidgen setup"]],
  ["get", "/api/v1/contracts/{contract_id}", ["pidgen contract show", "pidgen contract accept"]],
  ["post", "/api/v1/contracts/{contract_id}/proposals", ["pidgen contract propose"]],
  ["post", "/api/v1/contracts/{contract_id}/revisions", ["pidgen contract revise -f"]],
  [
    "post",
    "/api/v1/contracts/{contract_id}/revisions/{revision_number}/accept",
    ["pidgen contract accept"],
  ],
  ["get", "/api/v1/domains", ["pidgen domain list"]],
  ["post", "/api/v1/domains", ["pidgen domain create"]],
  ["get", "/api/v1/domains/{domain_id}", ["pidgen domain show"]],
  [
    "patch",
    "/api/v1/domains/{domain_id}",
    ["pidgen domain edit", "pidgen domain archive", "pidgen domain unarchive"],
  ],
  ["get", "/api/v1/domains/{domain_id}/contracts", ["pidgen contract list --domain"]],
  ["post", "/api/v1/domains/{domain_id}/contracts", ["pidgen contract create --domain"]],
  [
    "post",
    "/api/v1/domains/{domain_id}/contracts/publish",
    ["pidgen contract publish --domain", "pidgen contract create --domain --schema --existing"],
  ],
  ["get", "/api/v1/domains/{domain_id}/epics", ["pidgen domain epics"]],
  ["put", "/api/v1/domains/{domain_id}/parents/{parent_id}", ["pidgen domain parent add"]],
  ["delete", "/api/v1/domains/{domain_id}/parents/{parent_id}", ["pidgen domain parent rm"]],
  [
    "put",
    "/api/v1/domains/{domain_id}/people/{user_id}",
    ["pidgen domain member add", "pidgen domain maintainer add", "pidgen domain maintainer rm"],
  ],
  ["delete", "/api/v1/domains/{domain_id}/people/{user_id}", ["pidgen domain member rm"]],
  ["put", "/api/v1/domains/{domain_id}/projects/{project_ref}", ["pidgen domain project add"]],
  ["delete", "/api/v1/domains/{domain_id}/projects/{project_ref}", ["pidgen domain project rm"]],
  ["post", "/api/v1/feedback", ["pidgen feedback"]],
  [
    "get",
    "/api/v1/health",
    ["pidgen auth login", "pidgen auth status", "pidgen doctor", "pidgen setup"],
  ],
  ["get", "/api/v1/intents", ["pidgen intent list"]],
  ["post", "/api/v1/intents", ["pidgen intent submit -f"]],
  ["get", "/api/v1/intents/{conversation_id}", ["pidgen intent show"]],
  ["post", "/api/v1/intents/{conversation_id}/respond", ["pidgen intent respond"]],
  ["post", "/api/v1/intents/{conversation_id}/withdraw", ["pidgen intent withdraw"]],
  [
    "get",
    "/api/v1/me",
    [
      "pidgen account list",
      "pidgen auth login",
      "pidgen auth status",
      "pidgen doctor",
      "pidgen setup",
    ],
  ],
  ["get", "/api/v1/me/sessions", ["pidgen auth list"]],
  ["delete", "/api/v1/me/sessions/{session_id}", ["pidgen auth logout", "pidgen auth revoke"]],
  ["get", "/api/v1/projects", ["pidgen auth login", "pidgen project list"]],
  ["get", "/api/v1/projects/{project_ref}", ["pidgen project show"]],
  ["get", "/api/v1/projects/{project_ref}/contracts", ["pidgen contract list --project"]],
  ["post", "/api/v1/projects/{project_ref}/contracts", ["pidgen contract create --project"]],
  [
    "post",
    "/api/v1/projects/{project_ref}/contracts/proposals",
    ["pidgen contract propose --project", "pidgen contract create --schema"],
  ],
  [
    "post",
    "/api/v1/projects/{project_ref}/contracts/publish",
    ["pidgen contract publish --project", "pidgen contract create --schema --existing"],
  ],
  ["get", "/api/v1/requests", ["pidgen request list"]],
  ["post", "/api/v1/requests", ["pidgen request submit"]],
  [
    "get",
    "/api/v1/requests/{request_id}",
    [
      "pidgen request accept",
      "pidgen request acknowledge",
      "pidgen request close",
      "pidgen request promote",
      "pidgen request reply",
      "pidgen request show",
    ],
  ],
  ["post", "/api/v1/requests/{request_id}/accept", ["pidgen request accept"]],
  ["post", "/api/v1/requests/{request_id}/acknowledge", ["pidgen request acknowledge"]],
  ["post", "/api/v1/requests/{request_id}/ask", ["pidgen request reply --ask"]],
  ["post", "/api/v1/requests/{request_id}/attachments", ["pidgen request submit --evidence"]],
  ["post", "/api/v1/requests/{request_id}/close", ["pidgen request close"]],
  ["post", "/api/v1/requests/{request_id}/promote", ["pidgen request promote"]],
  ["post", "/api/v1/requests/{request_id}/reply", ["pidgen request reply"]],
  ["get", "/api/v1/requests/{request_id}/timeline", ["pidgen request show"]],
  ["get", "/api/v1/runs/{run_id}", ["pidgen run show"]],
  ["get", "/api/v1/runs/{run_id}/nodes/{node_id}", ["pidgen run node-output"]],
  [
    "get",
    "/api/v1/sessions/{session_id}/instructions",
    ["pidgen session edit-instruction", "pidgen session instructions"],
  ],
  ["post", "/api/v1/sessions/{session_id}/instructions", ["pidgen session steer"]],
  [
    "patch",
    "/api/v1/sessions/{session_id}/instructions/{instruction_id}",
    ["pidgen session edit-instruction"],
  ],
  [
    "post",
    "/api/v1/sessions/{session_id}/instructions/{instruction_id}/withdraw",
    ["pidgen session withdraw-instruction"],
  ],
  ["post", "/api/v1/ticket-manifests", ["pidgen manifest apply -f"]],
  [
    "get",
    "/api/v1/ticket-manifests/applications/{command_id}",
    ["pidgen manifest apply (while a commit is applying)"],
  ],
  ["post", "/api/v1/ticket-manifests/preview", ["pidgen manifest apply -f"]],
  ["get", "/api/v1/tickets", ["pidgen review list", "pidgen ticket list", "pidgen epic list"]],
  ["post", "/api/v1/tickets", ["pidgen ticket create -f", "pidgen epic create -f"]],
  ["get", "/api/v1/tickets/{ticket_id}", ["pidgen ticket show", "pidgen epic show"]],
  [
    "patch",
    "/api/v1/tickets/{ticket_id}",
    ["pidgen ticket edit", "pidgen ticket move", "pidgen epic edit"],
  ],
  [
    "get",
    "/api/v1/tickets/{ticket_id}/actions",
    ["pidgen ticket act", "pidgen ticket actions", "pidgen ticket retry"],
  ],
  [
    "post",
    "/api/v1/tickets/{ticket_id}/actions/execute",
    ["pidgen ticket act", "pidgen ticket retry"],
  ],
  [
    "post",
    "/api/v1/tickets/{ticket_id}/actions/preview",
    ["pidgen ticket act", "pidgen ticket retry"],
  ],
  ["post", "/api/v1/tickets/{ticket_id}/cancellation", ["pidgen ticket cancel"]],
  ["post", "/api/v1/tickets/{ticket_id}/cancellation/preview", ["pidgen ticket cancel"]],
  ["get", "/api/v1/tickets/{ticket_id}/child-plan", ["pidgen plan show"]],
  ["put", "/api/v1/tickets/{ticket_id}/child-plan", ["pidgen plan apply"]],
  ["post", "/api/v1/tickets/{ticket_id}/child-plan/preview", ["pidgen plan apply"]],
  ["get", "/api/v1/tickets/{ticket_id}/clarification", ["pidgen ticket clarify"]],
  ["post", "/api/v1/tickets/{ticket_id}/clarification", ["pidgen ticket clarify"]],
  [
    "post",
    "/api/v1/tickets/{ticket_id}/contracts",
    ["pidgen ticket contract implements", "pidgen ticket contract builds-against"],
  ],
  ["delete", "/api/v1/tickets/{ticket_id}/contracts/{contract_id}", ["pidgen ticket contract rm"]],
  ["get", "/api/v1/tickets/{ticket_id}/dependencies", ["pidgen ticket dep list"]],
  [
    "post",
    "/api/v1/tickets/{ticket_id}/dependencies",
    ["pidgen ticket dep add", "pidgen epic edge add"],
  ],
  ["get", "/api/v1/tickets/{ticket_id}/dependencies/graph", ["pidgen epic dag show"]],
  [
    "delete",
    "/api/v1/tickets/{ticket_id}/dependencies/{source_id}",
    ["pidgen ticket dep rm", "pidgen epic edge rm"],
  ],
  [
    "put",
    "/api/v1/tickets/{ticket_id}/following",
    ["pidgen ticket follow", "pidgen ticket unfollow"],
  ],
  ["get", "/api/v1/tickets/{ticket_id}/history", ["pidgen ticket history"]],
  ["get", "/api/v1/tickets/{ticket_id}/instructions", ["pidgen ticket instructions"]],
  ["put", "/api/v1/tickets/{ticket_id}/owner", ["pidgen ticket owner"]],
  ["get", "/api/v1/tickets/{ticket_id}/prerequisites", ["pidgen ticket show", "pidgen epic show"]],
  ["post", "/api/v1/tickets/{ticket_id}/promotion", ["pidgen plan promote"]],
  ["post", "/api/v1/tickets/{ticket_id}/promotion/preview", ["pidgen plan promote"]],
  ["post", "/api/v1/tickets/{ticket_id}/reopen", ["pidgen ticket reopen"]],
  ["post", "/api/v1/tickets/{ticket_id}/reopen/preview", ["pidgen ticket reopen"]],
  ["get", "/api/v1/tickets/{ticket_id}/runs", ["pidgen run list"]],
  ["get", "/api/v1/workers", ["pidgen worker status", "pidgen setup"]],
  ["post", "/api/v1/workers/enrollments", ["pidgen worker enroll", "pidgen setup"]],
  [
    "get",
    "/api/v1/workers/releases",
    [
      "pidgen worker install",
      "pidgen worker update",
      "pidgen worker status",
      "pidgen doctor",
      "pidgen setup",
    ],
  ],
  [
    "get",
    "/api/v1/workers/{host_id}/subscriptions",
    ["pidgen worker subscriptions", "pidgen worker subscriptions use"],
  ],
  [
    "put",
    "/api/v1/workers/{host_id}/subscriptions/{harness}/primary",
    ["pidgen worker subscriptions use"],
  ],
  ["get", "/api/v1/workflow-types", ["pidgen ticket types"]],
];

const METHODS = ["get", "post", "put", "patch", "delete"];

/** The report as Markdown, for a parsed public API document. */
export function renderCoverage(document) {
  const commands = new Map(
    COMMAND_OPERATIONS.map(([method, path, names]) => [`${method} ${path}`, names]),
  );
  const rows = [];
  for (const [path, operations] of Object.entries(document.paths)) {
    for (const method of Object.keys(operations)) {
      if (!METHODS.includes(method)) continue;
      const names = commands.get(`${method} ${path}`);
      rows.push({ method, path, command: names ? names.map((n) => `\`${n}\``).join(", ") : "—" });
    }
  }
  rows.sort(
    (a, b) => a.path.localeCompare(b.path) || METHODS.indexOf(a.method) - METHODS.indexOf(b.method),
  );
  const used = rows.filter((row) => row.command !== "—").length;
  return [
    "# API coverage",
    "",
    `Every operation of the published public API document (version ${document.info.version}) and the`,
    "`pidgen` command that calls it. An operation marked `—` has no command and is reachable only",
    "through `pidgen api <method> <path>`. Generated by `npm run api:coverage` in the CLI repository.",
    "",
    "| Operations | Count |",
    "|---|---|",
    `| Published | ${rows.length} |`,
    `| Called by a command | ${used} |`,
    `| No command yet | ${rows.length - used} |`,
    "",
    "| Method | Route | Command |",
    "|---|---|---|",
    ...rows.map((row) => `| \`${row.method.toUpperCase()}\` | \`${row.path}\` | ${row.command} |`),
    "",
  ].join("\n");
}

async function main(argv) {
  const out = argv[0] === "--out" ? argv[1] : undefined;
  if (argv.length > 0 && (out === undefined || argv.length !== 2)) {
    process.stderr.write("usage: node scripts/api-coverage.mjs [--out <file>]\n");
    return 2;
  }
  const source = new URL("../contracts/openapi.json", import.meta.url);
  const report = renderCoverage(JSON.parse(await readFile(source, "utf8")));
  if (out === undefined) process.stdout.write(report);
  else await writeFile(out, report);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
