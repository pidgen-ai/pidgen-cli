import { describe, expect, it } from "vitest";
import { emptyMeta, failure, render, renderTable, success } from "../../src/core/envelope.js";
import { CliError, exitCodeForResponse, INITIATIVE_REFUSALS } from "../../src/core/errors.js";
import { ExitCode } from "../../src/core/exit-codes.js";

describe("envelope", () => {
  it("renders success as one JSON line", () => {
    const text = render(success({ id: "PIDGEN-1" }, emptyMeta()), "json");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(text)).toMatchObject({ ok: true, data: { id: "PIDGEN-1" }, error: null });
  });

  it("renders failure with code, message and details", () => {
    const error = new CliError("NOT_FOUND", "No such ticket", ExitCode.NotFound, { ref: "X" });
    expect(JSON.parse(render(failure(error, emptyMeta()), "json"))).toMatchObject({
      ok: false,
      data: null,
      error: { code: "NOT_FOUND", message: "No such ticket", details: { ref: "X" } },
    });
  });

  it("always carries the CLI version in meta", () => {
    expect(emptyMeta().cli_version).toBe("0.0.0-test");
  });
});

describe("renderTable", () => {
  it("renders rows with a header", () => {
    expect(renderTable([{ skill: "a", state: "current" }])).toBe("SKILL  STATE\na      current\n");
  });

  it("renders a record as key/value lines", () => {
    expect(renderTable({ id: "PIDGEN-1", stage: "done" })).toBe("id     PIDGEN-1\nstage  done\n");
  });
});

// AC-183cdedfcc9e: generic results must never silently lose data.
describe("human fallback", () => {
  it("gives null and empty results explicit states", () => {
    expect(renderTable(null)).toMatch(/completed|no data/i);
    expect(renderTable([])).toMatch(/no results|empty/i);
    expect(renderTable({})).toMatch(/no data|empty/i);
  });
  it.each([false, 0, "visible", ""])("keeps scalar %s visible", (value) => {
    expect(renderTable(value).trim()).toBe(value === "" ? "(empty string)" : String(value));
  });
  it("labels nested structure and retains every mixed array entry", () => {
    const output = renderTable({ groups: [{ name: "alpha", flags: [true, null, 0] }], extra: [] });
    for (const value of ["groups", "name", "alpha", "flags", "true", "null", "0", "extra"])
      expect(output).toContain(value);
    const mixed = renderTable([
      "first",
      { id: "EXAMPLE-1", children: [{ text: "deep" }] },
      false,
      0,
      null,
      ["last"],
      "",
    ]);
    for (const value of [
      "first",
      "EXAMPLE-1",
      "children",
      "deep",
      "false",
      "0",
      "null",
      "last",
      "(empty string)",
    ])
      expect(mixed).toContain(value);
    expect(mixed.indexOf("first")).toBeLessThan(mixed.indexOf("EXAMPLE-1"));
    expect(mixed.indexOf("EXAMPLE-1")).toBeLessThan(mixed.indexOf("false"));
  });
});

// AC-adf559235e77, AC-04681e2aa962, AC-61fe2d8c300e.
const readCollections = [
  ["project list", "Projects"],
  ["domain list", "Domains"],
  ["ticket list", "Tickets"],
  ["epic list", "Epics"],
  ["intent list", "Intents"],
  ["request list", "Requests"],
  ["run list", "Runs"],
  ["review list", "Review tickets"],
  ["ticket types", "Workflow types"],
] as const;
const readDetails = [
  ["project show", "Project"],
  ["domain show", "Domain"],
  ["contract show", "Contract"],
  ["ticket show", "Ticket"],
  ["epic show", "Epic"],
  ["intent show", "Intent"],
  ["request show", "Request"],
  ["plan show", "Child plan"],
  ["run show", "Run"],
  ["run node-output", "Node output"],
  ["epic dag show", "Epic dependency graph"],
  ["api get", "API response"],
] as const;
function humanRead(command: string, data: unknown, columns = 80): string {
  return render(success(data, emptyMeta()), "table", {
    command: command.split(" "),
    terminal: { isTTY: true, columns },
  });
}

describe("resource reads", () => {
  it.each(readCollections)(
    "%s identifies compact populated and empty collections",
    (command, title) => {
      const data = [
        {
          ticket_key: "ALPHA-12",
          title: "Fix export",
          state: "open",
          nested: [{ body: "full detail belongs in show" }],
        },
      ];
      const before = JSON.stringify(data);
      const output = humanRead(command, data);
      expect(output).toContain(`${title} (1 displayed)`);
      for (const value of ["ALPHA-12", "Fix export", "open"]) expect(output).toContain(value);
      expect(output).not.toContain("full detail belongs in show");
      expect(output).not.toContain('{"');
      expect(humanRead(command, [])).toContain(`${title} (0 displayed): No results.`);
      expect(JSON.stringify(data)).toBe(before);
      expect(JSON.parse(render(success(data, emptyMeta()), "json")).data).toEqual(data);
    },
  );

  it.each(readDetails)("%s labels its subject and retains supporting detail", (command, title) => {
    const output = humanRead(command, {
      id: "EXAMPLE-12",
      title: "Fix export",
      prerequisites: { ready: false, blockers: [{ ticket_key: "ALPHA-3", stage: "running" }] },
      open_findings: [{ label: "Missing evidence", evidence: [{ path: "reports/result.md" }] }],
      attempts: [{ attempt: 1, status: "failed" }],
      output: {
        value: "first line\n  indented line\n\nlast line",
        artifacts: [{ path: "reports/fix.md" }],
      },
    });
    expect(output.startsWith(title)).toBe(true);
    for (const value of [
      "EXAMPLE-12",
      "Prerequisites",
      "Blockers",
      "ALPHA-3",
      "running",
      "Open findings",
      "Missing evidence",
      "Evidence",
      "reports/result.md",
      "Attempts",
      "failed",
      "Output",
      "Value",
      "Artifacts",
      "reports/fix.md",
    ])
      expect(output).toContain(value);
    expect(output).toMatch(/first line\n +indented line\n *\n +last line/);
    expect(output).not.toContain('"first line\\n');
  });

  it.each([40, 80, 120])(
    "reflows prose and record layouts at %s columns with intact actionable tokens",
    (width) => {
      const longKey = "ALPHA-" + "9".repeat(130);
      const digest = "sha256:" + "a".repeat(128);
      const path = "reports/" + "long-directory/".repeat(12) + "result.md";
      const recovery = `pidgen ticket act ${longKey} --action retry_run --digest ${digest} --ack RESTART_WORK`;
      const prose =
        "Read the evidence and inspect the failed attempt before choosing a recovery action. "
          .repeat(4)
          .trim();
      const output = humanRead(
        "run node-output",
        {
          node_id: "implement",
          description: prose,
          output: {
            output_digest: digest,
            artifacts: [{ path }],
            recovery,
            acknowledgement: "RESTART_WORK",
          },
        },
        width,
      );
      for (const value of [longKey, digest, path, recovery, "RESTART_WORK"])
        expect(output).toContain(value);
      expect(output.replace(/\s+/g, " ")).toContain(prose);
      for (const line of output.split("\n")) {
        if (![longKey, digest, path, recovery].some((token) => line.includes(token)))
          expect(line.length).toBeLessThanOrEqual(width);
      }
      const list = humanRead(
        "ticket list",
        [
          {
            ticket_key: "ALPHA-1",
            title: "First record with a title long enough to need a narrow layout",
            stage: "failed",
          },
          { ticket_key: "ALPHA-2", title: "Second record", stage: "completed" },
        ],
        width,
      );
      const first = list.indexOf("ALPHA-1"),
        second = list.indexOf("ALPHA-2");
      expect(first).toBeGreaterThan(-1);
      expect(second).toBeGreaterThan(first);
      expect(list.slice(first, second)).toContain("failed");
      expect(list.slice(second)).toContain("completed");
      for (const line of list.split("\n")) expect(line.length).toBeLessThanOrEqual(width);
    },
  );

  it("keeps action targets and recovery prerequisites beside their decisions", () => {
    const output = humanRead("ticket actions", {
      ticket_id: "TKT-example",
      actions: [
        {
          action: "replay_from_node",
          label: "Replay the node",
          state: "blocked",
          target: { run_id: "WFR-example", node_id: "verify" },
          refusal: {
            code: "REPLAY_REQUIRES_PRODUCER",
            message: "Replay the producer instead.",
            instead: "replay_from_node",
          },
        },
      ],
    });
    for (const value of [
      "Ticket actions",
      "Actions (1 displayed)",
      "Replay the node",
      "blocked",
      "Target",
      "WFR-example",
      "verify",
      "Refusal",
      "REPLAY_REQUIRES_PRODUCER",
      "Replay the producer instead.",
    ])
      expect(output).toContain(value);
  });

  it.each([
    [
      "ticket dep list",
      "Ticket dependencies",
      { blocked_by: [], blocks: [], inherited_blocked_by: [] },
      "Blocked by",
    ],
    ["ticket history", "Ticket history", { entries: [], next_after: null }, "Entries"],
    ["ticket instructions", "Ticket instructions", [], "Ticket instructions"],
    ["session instructions", "Session instructions", [], "Session instructions"],
    [
      "review attention",
      "Attention queue",
      { findings: [], requests: [], open_count: 0 },
      "Findings",
    ],
    ["plan cohorts", "Cohort plan", { cohorts: [], edges: [], warnings: [] }, "Cohorts"],
    ["domain epics", "Initiatives", { epics: [], tickets: [], running: 0 }, "Initiatives"],
    ["contract list", "Contracts", { provides: [], builds_against: [] }, "Provides"],
  ])("%s identifies its sections and their empty states", (command, title, data, section) => {
    const output = humanRead(command as string, data);
    expect(output.startsWith(title as string)).toBe(true);
    expect(output).toContain(`${section} (0 displayed): No results.`);
  });
});

describe("resource identity and width edge cases", () => {
  it("retains project prefixes, intake request IDs and workflow labels in compact lists", () => {
    expect(
      humanRead("project list", [{ id: "proj-example", name: "Example", prefix: "ALPHA" }]),
    ).toContain("ALPHA");
    expect(
      humanRead("intent list", [
        { request_id: "conv-example", title: "Example", state: "clarifying" },
      ]),
    ).toContain("conv-example");
  });
  it.each([40, 80, 120])("reflows empty headings and scalar prose at %s columns", (width) => {
    const output = humanRead(
      "ticket dep list",
      {
        inherited_blocked_by: [],
        notes: [
          "Read the complete report before selecting the action that will resume this ticket safely.",
        ],
      },
      width,
    );
    for (const line of output.split("\n")) expect(line.length).toBeLessThanOrEqual(width);
    expect(output.replace(/\s+/g, " ")).toContain(
      "Read the complete report before selecting the action that will resume this ticket safely.",
    );
  });
  it("keeps multiline code and commands in scalar output and text arrays copyable", () => {
    const command =
      "pidgen ticket act ALPHA-12 --action replay_from_node --run WFR-example --node implement";
    expect(humanRead("api get", command, 40)).toContain(command);
    expect(
      humanRead("run node-output", { output: { value: [command, "one\n  two\n\nthree"] } }, 40),
    ).toMatch(/one\n +two\n *\n +three/);
  });
});

it.each([40, 80, 120])("compact reads retain actionable fields at %s columns", (width) => {
  const digest = "sha256:" + "f".repeat(128);
  const path = "reports/" + "nested-directory/".repeat(8) + "evidence.md";
  const command =
    "pidgen ticket act ALPHA-12 --action retry_run --run WFR-example --ack RESTART_WORK";
  const output = humanRead(
    "ticket list",
    [
      {
        key: "ALPHA-12",
        path,
        output_digest: digest,
        acknowledgement: "RESTART_WORK",
        recovery: command,
        target: { run_id: "WFR-example", node_id: "implement" },
      },
    ],
    width,
  );
  for (const value of [path, digest, command, "RESTART_WORK", "WFR-example", "implement"])
    expect(output).toContain(value);
});

it("uses a compact projection for raw API collections without expanding nested bodies", () => {
  const output = humanRead("api get", [
    { id: "EXAMPLE-12", state: "open", details: { body: "Read the full detail separately." } },
  ]);
  expect(output).toContain("API response (1 displayed)");
  expect(output).toContain("EXAMPLE-12");
  expect(output).toContain("open");
  expect(output).not.toContain("Read the full detail separately.");
});

// AC-2a7583a429a3, AC-2e443d6f3bc5: mutation views preserve actionable values.
const previewCommands = [
  "ticket act",
  "ticket retry",
  "ticket replay",
  "ticket reopen",
  "ticket cancel",
  "plan apply",
  "plan promote",
  "manifest apply",
];
const mutationCommands = [
  ...previewCommands,
  "ticket create",
  "ticket edit",
  "ticket owner",
  "ticket follow",
  "ticket unfollow",
  "ticket dep add",
  "ticket dep rm",
  "ticket move",
  "ticket clarify",
  "ticket template",
  "ticket contract implements",
  "ticket contract builds-against",
  "ticket contract rm",
  "epic create",
  "epic edit",
  "epic edge add",
  "epic edge rm",
  "domain create",
  "domain edit",
  "domain archive",
  "domain unarchive",
  "domain project add",
  "domain project rm",
  "domain parent add",
  "domain parent rm",
  "domain member add",
  "domain member rm",
  "domain maintainer add",
  "domain maintainer rm",
  "contract create",
  "contract revise",
  "contract accept",
  "contract publish",
  "contract propose",
  "intent submit",
  "intent respond",
  "intent withdraw",
  "request submit",
  "request reply",
  "request acknowledge",
  "request accept",
  "request close",
  "request promote",
  "session steer",
  "session edit-instruction",
  "session withdraw-instruction",
  "feedback",
  "api post",
  "api put",
  "api patch",
  "api delete",
  "plan template",
  "manifest template",
];

describe("mutation presentation", () => {
  it.each([40, 80, 120])(
    "explains every preview shape and copyable requirements at width %s",
    (columns) => {
      const digest = "sha256:" + "a".repeat(64);
      const data = {
        preview_digest: digest,
        required_acknowledgements: ["discards_workspace", "cancels_descendants"],
        consequence: { run: "fresh" },
        effects: { deletes: ["workspace-example"] },
        blockers: [{ code: "WORK_REMAINS", repair: "pidgen ticket show EXAMPLE-12 --format json" }],
        warnings: ["Review retained files before applying."],
        findings: { root: [{ code: "CHECK_PLAN", blocks: "promotion", path: "$.root.objective" }] },
        committable: true,
        promotable: false,
        plan: { root: "EXAMPLE-12" },
      };
      for (const command of previewCommands) {
        const before = JSON.stringify(data);
        const output = humanRead(command, data, columns);
        expect(output).toContain("Preview — not applied.");
        expect(output).toContain("Proposed effects and requirements");
        for (const value of [
          digest,
          "discards_workspace",
          "cancels_descendants",
          "fresh",
          "workspace-example",
          "WORK_REMAINS",
          "CHECK_PLAN",
          "$.root.objective",
          "EXAMPLE-12",
        ])
          expect(output).toContain(value);
        expect(output).toContain(
          `--apply --digest ${digest} --ack discards_workspace --ack cancels_descendants`,
        );
        expect(output).toContain("same arguments and input");
        expect(output).toContain("Repair blockers");
        expect(JSON.stringify(data)).toBe(before);
        const wrapped = humanRead(command, { mode: "preview", preview: data }, columns);
        expect(wrapped).toContain("Preview — not applied.");
      }
    },
  );

  it("does not invent digest or acknowledgements for a dry run", () => {
    const output = humanRead("contract publish", { dry_run: true, added: ["exportReport"] });
    expect(output).toContain("Preview — not applied.");
    expect(output).toContain("exportReport");
    expect(output).not.toContain("--digest");
    expect(output).not.toContain("--ack");
  });

  it.each([40, 80, 120])(
    "distinguishes settled, pending and cancellation convergence at width %s",
    (columns) => {
      const handle = "/api/v1/tickets/EXAMPLE-12/commands/" + "b".repeat(80);
      const followup = `pidgen api get ${handle} --format json`;
      const settled = humanRead(
        "manifest apply",
        {
          settled: true,
          tickets: { root: "EXAMPLE-12", child: "EXAMPLE-13" },
          promoted: false,
          result: { status: "applied" },
        },
        columns,
      );
      expect(settled).toContain("Applied — settled.");
      expect(settled).toContain("EXAMPLE-12");
      expect(settled).toContain("EXAMPLE-13");
      expect(settled).toMatch(/Promoted: false/);
      const pending = humanRead(
        "plan promote",
        {
          settled: false,
          handle,
          result: { status: "applying", status_url: handle, next: followup },
        },
        columns,
      );
      expect(pending).toContain("Accepted — still pending.");
      expect(pending).toContain(handle);
      expect(pending).toContain(followup);
      expect(pending).not.toMatch(/Applied — settled|Completed/);
      const cancellation = humanRead(
        "ticket cancel",
        { settled: true, result: { state: "halting", cancellation_id: "cancel-example" } },
        columns,
      );
      expect(cancellation).toContain("Accepted — still pending.");
      expect(cancellation).not.toContain("Applied — settled");
    },
  );

  it.each([40, 80, 120])("retains timeout handles and refusal recovery at width %s", (columns) => {
    const handle = "/api/v1/ticket-manifests/applications/" + "c".repeat(80);
    for (const [code, details] of [
      [
        "TIMEOUT",
        {
          handle,
          last: {
            status: "applying",
            status_url: handle,
            next: `pidgen api get ${handle} --format json`,
          },
        },
      ],
      [
        "ACKNOWLEDGEMENT_REQUIRED",
        {
          missing: ["discards_workspace"],
          preview: {
            preview_digest: "sha256:review",
            required_acknowledgements: ["discards_workspace"],
            effects: ["remove workspace"],
          },
          next: "Review the preview before applying.",
        },
      ],
      [
        "MANIFEST_NOT_COMMITTABLE",
        {
          committable: false,
          blocking: ["INVALID_EDGE"],
          findings: { root: [{ code: "INVALID_EDGE", path: "$.edges[0]" }] },
        },
      ],
    ] as const) {
      const error = new CliError(
        code,
        "Review the change.",
        code === "TIMEOUT" ? ExitCode.Network : ExitCode.Refused,
        details,
      );
      const output = render(failure(error, emptyMeta()), "table", {
        command: ["manifest", "apply"],
        terminal: { isTTY: true, columns },
      });
      expect(output).toContain(code);
      if (code === "TIMEOUT") {
        expect(output).toContain("Wait timed out — still pending.");
        expect(output).toContain(handle);
        expect(output).toContain(`pidgen api get ${handle} --format json`);
        expect(output).not.toMatch(/Applied — settled|Completed/);
      } else if (code === "ACKNOWLEDGEMENT_REQUIRED") {
        expect(output).toContain("--apply --digest sha256:review --ack discards_workspace");
        expect(output).toContain("remove workspace");
      } else {
        expect(output).toContain("INVALID_EDGE");
        expect(output).toContain("$.edges[0]");
      }
    }
  });

  it.each(mutationCommands)("%s labels responses and retains direct result details", (command) => {
    const data = {
      ticket_key: "EXAMPLE-14",
      status: "recorded",
      warnings: ["Review the change"],
      recovery: "pidgen ticket show EXAMPLE-14 --format json",
      extra: [{ code: "NOTICE", text: "Retained detail" }],
    };
    const output = humanRead(command, data, 40);
    expect(output).toContain(command + "\n");
    for (const value of ["EXAMPLE-14", "NOTICE", "Retained detail", data.recovery])
      expect(output).toContain(value);
  });

  it.each(["queued", "dispatched", "accepted", "applying", "pending", "halting"])(
    "does not claim completion for direct %s responses",
    (state) => {
      const output = humanRead("session steer", {
        state,
        instruction_id: "ins-example",
        next: "Read the instruction state later.",
      });
      expect(output).toContain("Accepted — still pending.");
      expect(output).toContain("ins-example");
      expect(output).not.toMatch(/Applied — settled|Completed/);
    },
  );

  it("reports clarification as outstanding and keeps created identities and promotion state", () => {
    const clarification = humanRead("intent submit", {
      outcome: "needs_clarification",
      request: { conversation_id: "conv-example", questions: [{ text: "Which project?" }] },
    });
    expect(clarification).toContain("Needs clarification.");
    expect(clarification).toContain("conv-example");
    expect(clarification).toContain("Which project?");
    const created = humanRead("request promote", { ticket: { key: "EXAMPLE-15" }, promoted: true });
    expect(created).toContain("EXAMPLE-15");
    expect(created).toContain("Promoted: true");
  });
});

it.each([40, 80, 120])(
  "mutation handles and application values remain copyable at width %s",
  (columns) => {
    const handle = "/api/v1/operations/an opaque handle that is longer than the terminal width";
    const data = { settled: false, handle, result: { operation_handle: handle } };
    const output = humanRead("ticket act", data, columns);
    expect(output).toContain(handle);
    expect(output.match(new RegExp(handle, "g"))).toHaveLength(2);
  },
);

it("prints a refusal preview once alongside its application flags", () => {
  const error = new CliError(
    "DIGEST_REQUIRED",
    "Review the preview.",
    ExitCode.ConfirmationRequired,
    {
      preview: {
        preview_digest: "sha256:single-preview",
        required_acknowledgements: ["completed_source"],
        effects: ["fresh attempt"],
      },
      missing: ["completed_source"],
    },
  );
  const output = render(failure(error, emptyMeta()), "table", { command: ["ticket", "retry"] });
  expect(output.match(/fresh attempt/g)).toHaveLength(1);
  expect(output).toContain("Missing");
  expect(output).toContain("--ack completed_source");
});

it("keeps raw API preview instructions within the raw command's policy", () => {
  const output = humanRead("api post", {
    preview_digest: "sha256:raw-preview",
    required_acknowledgements: ["completed_source"],
    effects: ["fresh attempt"],
  });
  expect(output).toContain("Preview — not applied.");
  expect(output).toContain("sha256:raw-preview");
  expect(output).toContain("completed_source");
  expect(output).not.toContain("--apply");
  expect(output).not.toContain("--check");
  expect(output).toContain("public apply route");
});

it("does not label a direct applied response carrying preview fields as a preview", () => {
  const output = humanRead("api post", {
    status: "applied",
    preview_digest: "sha256:raw-preview",
    required_acknowledgements: [],
    ticket_key: "EXAMPLE-21",
  });
  expect(output).not.toContain("Preview — not applied.");
  expect(output).toContain("applied");
  expect(output).toContain("EXAMPLE-21");
});

// AC-991b1073fe76: errors retain diagnostics and scriptable recovery at every width.
describe.each([40, 80, 120])("diagnostic failures at %s columns", (columns) => {
  it.each([
    {
      command: "doctor",
      code: "DOCTOR_FAILED",
      message: "Checks failed.",
      details: {
        checks: [
          {
            id: "runtime",
            status: "fail",
            summary: "Runtime unavailable.",
            fix: "pidgen worker install --runtime wheel",
          },
        ],
      },
      fragments: [
        "runtime",
        "fail",
        "Runtime unavailable.",
        "pidgen worker install --runtime wheel",
      ],
    },
    {
      command: "worker verify",
      code: "VERIFY_FAILED",
      message: "Verification failed.",
      details: {
        checks: [
          {
            id: "signature",
            status: "fail",
            summary: "Signature refused.",
            fix: "pidgen worker install",
          },
        ],
        record: { version: "1.0.0" },
      },
      fragments: ["signature", "Signature refused.", "pidgen worker install", "1.0.0"],
    },
    {
      command: "manifest apply",
      code: "MANIFEST_BLOCKED",
      message: "Manifest blocked.",
      details: {
        findings: [
          {
            code: "MISSING_PROJECT",
            blocking: true,
            message: "Choose a project.",
            fix: "pidgen project list",
          },
        ],
      },
      fragments: ["MISSING_PROJECT", "Blocking: true", "Choose a project.", "pidgen project list"],
    },
    {
      command: "setup",
      code: "TERMINAL_REQUIRED",
      message: "Setup needs a terminal.",
      details: {
        commands: [
          "pidgen auth login https://pidgen.example.com",
          "pidgen worker install",
          "pidgen worker enroll --no-install",
          "pidgen worker start --detach",
        ],
      },
      fragments: [
        "pidgen auth login https://pidgen.example.com",
        "pidgen worker install",
        "pidgen worker enroll --no-install",
        "pidgen worker start --detach",
      ],
    },
    {
      command: "worker update",
      code: "UPDATE_ROLLED_BACK",
      message: "Update rolled back.",
      details: {
        running: false,
        log_tail: ["worker startup refused"],
        restart_error: { code: "WORKER_EXITED", message: "Restart failed." },
        fix: "pidgen worker start --detach",
      },
      fragments: [
        "Running: false",
        "worker startup refused",
        "WORKER_EXITED",
        "Restart failed.",
        "pidgen worker start --detach",
      ],
    },
  ])("retains $code details", ({ command, code, message, details, fragments }) => {
    const envelope = failure(
      new CliError(code, message, ExitCode.Unexpected, details),
      emptyMeta(),
    );
    const before = JSON.stringify(envelope);
    const output = render(envelope, "table", {
      command: command.split(" "),
      terminal: { isTTY: true, columns },
    });
    expect(output).toContain(`error ${code}: ${message}`);
    for (const fragment of fragments) expect(output).toContain(fragment);
    expect(render(envelope, "json")).toBe(before + "\n");
  });
});

// AC-e9b2af44165c, AC-13099f01c6dd: lifecycle output keeps all supplied qualifications.
describe.each([40, 80, 120])("lifecycle presentation at %s columns", (columns) => {
  it.each([
    ["auth login", "Signed in.", { account: "ACC-EXAMPLE", verified: true }],
    ["auth logout", "Stored credential removed.", { removed: true, revoked: false }],
    ["auth revoke", "Credential revoked.", { revoked: true, current: true }],
    ["auth list", "Sessions and CLI tokens", [{ id: "session-example", current: true }]],
    [
      "auth status",
      "Authentication",
      { credential_kind: "pat", identity_note: "Only the local profile is shown." },
    ],
    ["account list", "Accounts", [{ account: "ACC-EXAMPLE", member: null, default: true }]],
    [
      "account use",
      "Default Account selected.",
      { account: "ACC-EXAMPLE", previous_default: null },
    ],
    [
      "worker install",
      "Worker installed.",
      { installed: true, location: "/example/worker", version: "1.0.0" },
    ],
    ["worker update", "Worker updated.", { updated: true, restarted: false, running: true }],
    ["worker uninstall", "Worker uninstalled.", { removed: ["tool pidgen-worker"], purged: false }],
    [
      "worker enroll",
      "Worker enrolled.",
      { enrolled: true, worker: { host_id: "worker.example.com" } },
    ],
    ["worker start", "Worker started in background.", { running: true, record: { pid: 123 } }],
    ["worker stop", "Worker stopped.", { forced: false, record: { pid: 123 } }],
    [
      "worker restart",
      "Worker restarted in background",
      { stopped: { forced: false, record: { pid: 123 } }, record: { pid: 124 }, running: true },
    ],
    [
      "worker restart",
      "Worker restarted in background",
      {
        stopped: { forced: false, record: { container: "pidgen-worker" } },
        record: { container: "pidgen-worker", status: "running" },
        running: true,
      },
    ],
    [
      "worker status",
      "Worker status",
      {
        running: false,
        server: null,
        warnings: [
          {
            code: "NETWORK",
            message: "Service unreachable; local status only.",
            details: { retry: "pidgen worker status" },
          },
        ],
      },
    ],
    [
      "worker verify",
      "Worker verification",
      {
        checks: [
          {
            id: "release",
            status: "warn",
            summary: "Supported, newer release available.",
            fix: "pidgen worker update",
          },
        ],
      },
    ],
    [
      "worker doctor",
      "Worker diagnostics",
      { healthy: true, checks: [{ name: "runtime", ok: true }] },
    ],
    [
      "worker subscriptions",
      "Worker subscriptions",
      { connected: false, advertised: false, harnesses: [] },
    ],
    [
      "worker subscriptions use",
      "Outcome unknown",
      {
        outcome: "unknown",
        detail: "Worker did not answer.",
        primary: "example",
        active: "fallback",
      },
    ],
    [
      "setup",
      "Setup complete.",
      {
        steps: [
          { id: "prove", status: "done", summary: "Connected.", command: "pidgen worker doctor" },
        ],
      },
    ],
    [
      "doctor",
      "Diagnostics",
      {
        checks: [{ id: "harness", status: "skip", summary: "Not checked.", fix: "pidgen doctor" }],
      },
    ],
    [
      "skills status",
      "Skills status",
      {
        skills: [{ skill: "example-skill", state: "missing" }],
        contract: {
          state: "unchecked",
          reason: { code: "NETWORK", message: "Service unreachable." },
        },
      },
    ],
  ])("labels %s without losing supplied fields", (command, heading, data) => {
    const envelope = success(data, emptyMeta());
    const before = JSON.stringify(envelope);
    const output = humanRead(command, data, columns);
    expect(output).toContain(heading);
    const values = (value: unknown): unknown[] =>
      value && typeof value === "object" ? Object.values(value).flatMap(values) : [value];
    for (const value of values(data)) {
      if (value !== null) expect(output.replace(/\s+/g, " ")).toContain(String(value));
    }
    expect(render(envelope, "json")).toBe(before + "\n");
  });

  it("identifies differing and unchecked contracts alongside skills", () => {
    for (const contract of [
      {
        state: "different",
        only_in_cli: ["GET /api/v1/example"],
        only_on_server: ["POST /api/v1/example"],
        reason: null,
      },
      { state: "unchecked", reason: { code: "TIMEOUT", message: "Document could not be read." } },
    ]) {
      const output = humanRead("skills status", { skills: [], contract }, columns);
      expect(output).toContain(
        contract.state === "different" ? "Contract differs" : "Contract unchecked",
      );
      expect(output).toContain(contract.state);
      if (contract.state === "different") {
        expect(output).toContain("GET /api/v1/example");
        expect(output).toContain("POST /api/v1/example");
      } else {
        expect(output).toContain("TIMEOUT");
        expect(output.replace(/\s+/g, " ")).toContain("Document could not be read.");
      }
    }
  });

  it("retains warnings attached to compact resource rows", () => {
    const output = humanRead(
      "project list",
      [
        {
          key: "EXAMPLE",
          name: "Example",
          warnings: [
            {
              code: "PARTIAL",
              message: "Service unavailable.",
              fix: "pidgen project show EXAMPLE",
            },
          ],
        },
      ],
      columns,
    );
    expect(output).toContain("PARTIAL");
    expect(output).toContain("Service unavailable.");
    expect(output).toContain("pidgen project show EXAMPLE");
  });
});

it("counts both worker and CLI diagnostic check shapes without treating skips as passes", () => {
  const output = humanRead("worker doctor", {
    healthy: true,
    checks: [
      { name: "runtime", ok: true },
      { name: "optional", status: "skip" },
      { name: "login", ok: false },
    ],
  });
  expect(output).toContain("Checks: 1 ok, 0 warnings, 1 failed, 1 skipped.");
});

// AC-c8e82b49e423, AC-d420a2efc504, AC-431a20d66a7a, AC-8ac423527b9f: `worker status` says when no
// worker is installed, how to install one, and why the server may still list this machine.
describe("worker status install state", () => {
  const ENROLLED = {
    host_id: "worker.example.com",
    enrolled: true,
    worker: { host_id: "worker.example.com", revoked_at: null },
    service_protocol: "2.3",
    accepted_protocols: ["2.3"],
  };

  it("leads with Worker not installed. and the install command when nothing is installed", () => {
    const output = humanRead("worker status", {
      installed: false,
      record: null,
      running: false,
      update: { installed: null, current: null, needed: false, reason: null },
    });
    const lines = output.split("\n");
    expect(lines[0]).toBe("Worker not installed.");
    expect(lines).not.toContain("Worker status");
    expect(output).toContain("pidgen worker install");
    expect(output).not.toContain("still enrolled");
  });

  it("explains a machine still enrolled, with its credential kept, under the not-installed heading", () => {
    const output = humanRead("worker status", {
      installed: false,
      record: null,
      running: false,
      server: ENROLLED,
      update: { installed: null, current: "1.0", needed: false, reason: null },
      warnings: [],
    });
    const prose = output.replace(/\s+/g, " ");
    expect(output.split("\n")[0]).toBe("Worker not installed.");
    expect(prose).toContain("pidgen worker install");
    expect(prose).toContain("still enrolled on the App Service");
    expect(prose).toContain("credential was kept");
    expect(prose).toContain("--purge");
  });

  it("does not mention enrollment when the server does not list this machine as enrolled", () => {
    const output = humanRead("worker status", {
      installed: false,
      record: null,
      running: false,
      server: { ...ENROLLED, enrolled: false, worker: null },
      update: { installed: null, current: "1.0", needed: false, reason: null },
      warnings: [],
    });
    expect(output.split("\n")[0]).toBe("Worker not installed.");
    expect(output).not.toContain("still enrolled");
  });

  it.each([40, 80, 120])("wraps the not-installed notes at width %s", (columns) => {
    const output = humanRead(
      "worker status",
      { installed: false, record: null, running: false, server: ENROLLED, warnings: [] },
      columns,
    );
    expect(output.split("\n")[0]).toBe("Worker not installed.");
    for (const line of output.trimEnd().split("\n"))
      expect(line.length).toBeLessThanOrEqual(columns);
  });

  it("keeps the Worker status heading, with no install hint, when a worker is installed", () => {
    const output = humanRead("worker status", {
      installed: true,
      record: null,
      running: false,
      server: ENROLLED,
      update: { installed: "1.0.0", current: "1.0", needed: false, reason: null },
      warnings: [],
    });
    expect(output.split("\n")[0]).toBe("Worker status");
    expect(output).not.toContain("Worker not installed.");
    expect(output).not.toContain("pidgen worker install");
    expect(output).not.toContain("still enrolled");
  });
});

it.each([40, 80, 120])("wraps lifecycle summary prose at width %s", (columns) => {
  const output = humanRead(
    "worker status",
    {
      running: true,
      server: null,
      warnings: [
        {
          code: "NETWORK",
          message:
            "The service could not be reached, so this result describes only the local worker process.",
        },
      ],
    },
    columns,
  );
  for (const line of output.trimEnd().split("\n")) expect(line.length).toBeLessThanOrEqual(columns);
});

// AC-941bd4e2e23a: array context identifies opaque values, including ones with spaces.
it.each([40, 80, 120])("keeps actionable array values intact at width %s", (columns) => {
  const values = {
    paths: ["reports/" + "a directory with spaces/".repeat(8) + "result.md"],
    required_acknowledgements: ["Review " + "all changes ".repeat(15)],
    operation_handles: ["opaque " + "handle value ".repeat(15)],
    resource_keys: ["EXAMPLE " + "key value ".repeat(15)],
  };
  const output = humanRead("run node-output", values, columns);
  for (const entries of Object.values(values)) expect(output).toContain(entries[0]);
});

it.each([40, 80, 120])(
  "wraps mutation guidance at width %s without splitting apply flags",
  (columns) => {
    const digest = "sha256:" + "a".repeat(64);
    const output = humanRead(
      "ticket act",
      {
        preview_digest: digest,
        required_acknowledgements: ["RESTART_WORK"],
        blockers: ["Resolve the outstanding review findings before starting another attempt."],
        reason_required: true,
      },
      columns,
    );
    const flags = `--apply --digest ${digest} --ack RESTART_WORK`;
    expect(output).toContain(flags);
    expect(output.replace(/\s+/g, " ")).toContain("same arguments and input");
    for (const line of output.trimEnd().split("\n")) {
      if (!line.includes(digest) && !line.includes(flags))
        expect(line.length).toBeLessThanOrEqual(columns);
    }
  },
);

// A Domain Epic is an Initiative wherever a person reads it: the CLI's own sentence for each
// Initiative refusal says so, beside the server's message, which it relays verbatim. Codes, exit
// codes and the JSON envelope are unchanged.
describe("Initiative refusals", () => {
  const SENTENCES: Record<string, string> = {
    PARENT_OUTSIDE_DOMAIN:
      "The parent is an Initiative whose domain does not cover this ticket's project, or is not above the new Initiative's domain: name an Initiative whose domain covers the project.",
    DOMAIN_HAS_NO_PROJECTS:
      "The domain contains no project, so it has no home for an Initiative: add a project to it first (pidgen domain project add).",
    DOMAIN_PROJECT_CONFLICT:
      "An Initiative is filed in a domain instead of a project: name the domain or the project, not both.",
    DOMAIN_HAS_OPEN_EPICS:
      "The domain's home holds an open Initiative, so the domain cannot be archived: finish the Initiatives listed below first.",
    DOMAIN_COVERAGE_IN_USE:
      "Open work under an Initiative in this domain, or in a domain above it, sits in a project the change takes out of its coverage: move that work first.",
  };

  it("names a sentence for every Initiative refusal, each saying Initiative", () => {
    expect(INITIATIVE_REFUSALS).toEqual(SENTENCES);
    for (const sentence of Object.values(INITIATIVE_REFUSALS)) {
      expect(sentence).toContain("Initiative");
      expect(sentence).not.toMatch(/Domain Epic|Account Epic/);
    }
  });

  it.each([
    ["PARENT_OUTSIDE_DOMAIN", 422, ExitCode.Usage],
    ["DOMAIN_HAS_NO_PROJECTS", 422, ExitCode.Refused],
    ["DOMAIN_PROJECT_CONFLICT", 422, ExitCode.Usage],
    ["DOMAIN_HAS_OPEN_EPICS", 409, ExitCode.Refused],
    ["DOMAIN_COVERAGE_IN_USE", 422, ExitCode.Refused],
  ] as const)("%s keeps its code and exit code", (code, status, exitCode) => {
    expect(exitCodeForResponse(status, code)).toBe(exitCode);
  });

  it.each([
    ["PARENT_OUTSIDE_DOMAIN", "ticket create", { parent_ticket_id: "PAY-12", project_id: "ALPHA" }],
    ["DOMAIN_HAS_NO_PROJECTS", "epic create", { domain_id: "dom-example-cards" }],
    ["DOMAIN_PROJECT_CONFLICT", "ticket create", {}],
    ["DOMAIN_HAS_OPEN_EPICS", "domain archive", { ticket_keys: ["PAY-12"] }],
    ["DOMAIN_COVERAGE_IN_USE", "domain project rm", { ticket_keys: ["ALPHA-3"] }],
    ["PARENT_OUTSIDE_DOMAIN", "ticket show", { parent_ticket_id: "PAY-12" }],
  ] as const)(
    "%s from %s prints the sentence after the server's message",
    (code, command, details) => {
      const message = `The server refuses: ${code}.`;
      const envelope = failure(new CliError(code, message, ExitCode.Refused, details), emptyMeta());
      const before = render(envelope, "json");
      const output = render(envelope, "table", {
        command: command.split(" "),
        terminal: { isTTY: true, columns: 200 },
      });
      const lines = output.split("\n");
      expect(lines[0]).toBe(`error ${code}: ${message}`);
      expect(lines[1]).toBe(SENTENCES[code]);
      for (const value of Object.values(details).flat()) expect(output).toContain(String(value));
      expect(output).not.toMatch(/Domain Epic|Account Epic/);
      expect(JSON.parse(before)).toMatchObject({ error: { code, message, details } });
      expect(render(envelope, "json")).toBe(before);
    },
  );

  it("adds no sentence to another refusal", () => {
    const envelope = failure(
      new CliError("DOMAIN_CYCLE", "The server refuses.", ExitCode.Refused),
      emptyMeta(),
    );
    expect(render(envelope, "table", { command: ["domain", "parent", "add"] })).toBe(
      "error DOMAIN_CYCLE: The server refuses.\n",
    );
  });
});
