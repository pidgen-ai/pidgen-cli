# Output and exit codes

## Format selection

Standard output (stdout) determines the default: a terminal gets human-readable output, while
nonterminal stdout (pipes, redirects and captured output) gets JSON. Standard error's terminal
state does not affect this choice. `--format json` always selects JSON; `--format table` always
selects human-readable output. Both apply to successes, failures and parser/usage errors, including
a recognized format flag when parsing fails before execution.

Scripts and agent skills that read structured responses should always pass `--format json`, even
when run in a terminal. Human output is presentation, not a parsing contract. For example:

```console
$ pidgen ticket show PIDGEN-12 --format json
$ pidgen ticket list --format table
$ pidgen ticket list > tickets.json
```

JSON payloads, nested values, metadata, error details and exit codes are unchanged by this
presentation choice. Only the terminal default changes.

## Resource reads in human output

Resource lists name the collection and show how many records are displayed. For example, an empty
list says `Tickets (0 displayed): No results.` Populated lists show identifying names or keys and
available state. They use a compact projection; use the resource's `show` command or
`--format json` for its full nested records.

Details name their subject and label supporting sections, including prerequisites, findings,
attempts, evidence, artifacts and output when present. Ticket actions keep their targets,
recommendations and refusals beside each decision. History and instruction lists retain each
entry's content. Node output, contract Markdown and schemas, request timelines and other
multiline text retain their line breaks and indentation rather than appearing as escaped JSON.

Contract lists separate what a project provides, what a domain owns, coverage grouped by provider,
and contracts built against. Domain Epic boards keep Epic, project and ticket references together,
including hidden-work counts. Child plans and cohort proposals label their items, dependencies,
findings, summaries and warnings. Raw `api get` responses also receive a labeled presentation.

At narrow terminal widths, compact tables switch to numbered records with labeled fields, and
prose wraps to the available width. Each record keeps its own fields and nested sections. Keys,
paths, digests and acknowledgement codes are never truncated or split; commands and multiline
text remain copyable even when a line exceeds the terminal width. Explicit `--format table`
without a reported terminal width uses 80 columns for resource reads.
Paths and other actionable values inside arrays keep the same protection, including paths with
spaces. Installation summaries and preview guidance also wrap prose while keeping destination
paths and application flags intact.

## Lifecycle results and diagnostics

Authentication, Account, worker, setup and skill-status responses name their outcome and retain
all supplied detail in labeled sections. Worker installation and updates distinguish changes from
an already installed or current version. A subscription change whose `outcome` is `unknown` says
to check the worker before retrying; it does not claim the primary changed.

Warnings appear alongside successful results and keep their original exit status. Worker status
explains when only local status is available and includes the service warning, update information
and any supplied recovery details. Skill status identifies a differing or unchecked API contract,
including differing operations or the reason it could not be checked. Diagnostic summaries count
passed, warning, failed and skipped checks separately, with each check's supplied fix below.

Human failures retain `error <code>: <message>` and show supplied details: failed checks and fixes,
blocking manifest findings, startup logs and rollback/restart information. Setup is the exception:
it draws its own failure block, and without a terminal it lists the equivalent scriptable
commands. Commands remain copyable at narrow widths.
Use `--format json` for the unchanged structured error and metadata.

Help, no-argument help and version remain text even with `--format json`. Setup's questions and
progress stay on standard error. In human output, setup has its own rendering: a successful run
ends with `└  Done in <m> min <s> s` and a summary card on standard output instead of its step
results, and a failure is the one `■` block setup draws on standard error, with nothing more on
standard output (no `error <code>:` line or details). With `--format json` its envelope is
unchanged. Authentication verification instructions and CLI-owned worker progress also keep their
established streams. Foreground worker execution continues to inherit the worker's streams and
exit status.

## The envelope

In JSON mode, envelope-producing commands write exactly one JSON document to standard output:

```json
{
  "ok": true,
  "data": { "id": "PIDGEN-12", "stage": "in_execution" },
  "error": null,
  "meta": {
    "request_id": "req_…",
    "api_version": "1.2",
    "profile": "default",
    "account": "ACC-EXAMPLE",
    "cli_version": "0.1.0-alpha.1"
  }
}
```

Foreground `pidgen worker start` is a subprocess exception: it hands the terminal to `pidgen-worker`, inherits
all three standard streams, and prints no CLI envelope. Its exit status is the worker's exit status.
`pidgen worker start --detach` uses the normal envelope.

On failure `ok` is `false`, `data` is `null`, and `error` is filled in:

```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "PREVIEW_STALE",
    "message": "The recovery plan changed since it was previewed.",
    "details": { "preview_digest": "sha256:…" }
  },
  "meta": { "request_id": "req_…", "api_version": "1.2", "profile": "default", "account": "ACC-EXAMPLE", "cli_version": "0.1.0-alpha.1" }
}
```

- `data` is the App Service's `data` for single-call commands. Commands that make several calls
  document their `data` shape in [Commands](commands.md).
- `error.code` is the App Service's error code when the server refused, or a CLI code (below) when
  the CLI failed before or after the call.
- `error.details` always carries the HTTP `status` and the `request_id` when the server refused
  ([Server errors](#server-errors)).
- Standard error carries progress lines only, and only when it is a terminal. Nothing a script
  needs is ever on standard error. The one exception is the verification address and user code of
  `pidgen auth login`, which a person must read and which are written even when it is not a terminal.
  `pidgen worker install` and `pidgen worker enroll` print every command they run there, and pass
  the output of the install and of `pidgen-worker enroll` through to standard error; `worker enroll`
  keeps its install instructions there. Only `pidgen setup` asks interactive questions.
- Human output renders results for people, with explicit empty states and structured nested values.
  Use `--format json` to parse the complete envelope.

## Server errors

Published routes answer a refusal in the public error shape:

```json
{
  "status": "error",
  "error": {
    "code": "INPUT_INVALID",
    "message": "The request body is invalid.",
    "details": { "errors": [{ "loc": ["body", "title"], "msg": "Field required" }] },
    "request_id": "req_…"
  }
}
```

The CLI maps it onto the envelope's `error` as follows:

| Public shape | Envelope |
|---|---|
| `error.code` | `error.code`, and it drives the exit code (below) |
| `error.message` | `error.message` |
| each key of `error.details` | the same key in `error.details` (so `INPUT_INVALID` keeps `details.errors`) |
| `error.details` that is not an object | `error.details.details` |
| `error.request_id` (else the `X-Request-Id` header) | `error.details.request_id` |
| HTTP status | `error.details.status` |

`status` and `request_id` in `error.details` always mean the HTTP status and the request id; a
server detail with either name is not copied. When the public shape has no `code`, the CLI uses the
status default (`INPUT_INVALID` for 400/422, `AUTH_REQUIRED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`,
`API_VERSION_UNSUPPORTED`, `TIMEOUT`, or `UNEXPECTED_RESPONSE`).

The exit code comes from `error.code` first: `PREVIEW_STALE`, `ACKNOWLEDGEMENT_REQUIRED` and
`DIGEST_REQUIRED` exit 6 whatever the HTTP status, and `REQUEST_WITHDRAW_FORBIDDEN` (a 403: the
caller may not withdraw an intake request) and `REQUEST_ALREADY_CREATED` (the request already became
a ticket) exit 5 whatever the status, because they are domain refusals. The Request refusals
(`REQUEST_VERSION_CONFLICT`, `REQUEST_TRANSITION_REFUSED`, `REQUEST_RATE_LIMITED`,
`REQUEST_SOURCE_PAUSED`, `REQUEST_BUG_DETAILS_REQUIRED`, `REQUEST_TARGET_NEEDS_PROJECT` and
`REQUEST_REPLIES_OFF`) exit 5 and `REQUEST_NOT_FOUND` exits 4 whatever the status, and `pidgen
request` prints each one's own sentence ([Commands](commands.md#request)). Otherwise the status
decides: 400 and 422 (for
example `INPUT_INVALID`) exit 2; 401 and 403 exit 3; 404 and 410 exit 4; 409, 412 and 423 exit 5;
426 exits 7; 408 and 504 exit 8; anything else exits 1. Three commands narrow this: `pidgen ticket
clarify` exits 5 for `CLARIFICATION_NOT_FOUND` (a 404), because the ticket exists and has no open
question to answer, which is a refusal rather than a missing resource. `pidgen ticket owner` exits 5
for `OWNER_NOT_ELIGIBLE` (a 422), because an ineligible owner is a domain refusal. `pidgen
feedback` exits 5 for `FEEDBACK_RATE_LIMITED` (a 429) and `FEEDBACK_MESSAGE_TOO_LONG` (a 422),
because the server refuses the feedback rather than the request being malformed. The steering
instruction commands add no mapping: the 409 refusals (`STEP_SETTLED`, `RUN_PAUSED`, `RUN_HELD`,
`INSTRUCTION_ALREADY_DELIVERED`, `INSTRUCTION_VERSION_STALE`) exit 5, the 404s exit 4, and
`INSTRUCTION_NOT_AUTHOR` exits 3 as every 403 does. `pidgen session edit-instruction` itself exits 4
with `INSTRUCTION_NOT_FOUND` when the session's list does not name the instruction. `pidgen ticket
cancel` adds no mapping either: `DELIVERY_IN_FLIGHT` and `PUBLICATION_RESULT_UNKNOWN` (409) exit 5
with their code, and `error.details.operation` carries the delivery operation that blocks the
cancellation; a `PREVIEW_STALE` for a `--close-pr` that differs from the preview's exits 6.

A response that is not in the public shape is still read as `{"detail": {"code", "message", …}}`
(the keys other than `code` and `message` go into `error.details`), a plain `{"detail": "…"}`
string (the message), or a `{"detail": [ … ]}` validation list (`error.details.issues`).

## Exit codes

| Code | Meaning | Typical `error.code` |
|---|---|---|
| 0 | Success | — |
| 1 | Unexpected error (a bug, an unexpected server response, failed diagnostics, a failing worker install, update, uninstall or enrollment, or an immediately exiting worker) | `CLI_INTERNAL`, `UNEXPECTED_RESPONSE`, `NOT_PIDGEN`, `DOCTOR_FAILED`, `SETUP_IS_THE_PROBLEM`, `WORKER_EXITED`, `INSTALL_FAILED`, `ENROLL_FAILED`, `INSTALL_RECORD_INVALID`, `DOWNLOAD_FAILED`, `UPDATE_ROLLED_BACK`, `ROLLBACK_FAILED`, `UNINSTALL_FAILED`, `DOCKER_FAILED`, `CAPACITY_REFUSED`, `CAPACITY_FAILED` |
| 2 | Usage error: bad flags, invalid input file, a path outside the public API, an unavailable local worker or worker runtime (including a Docker daemon that cannot be reached), a missing worker `worker enroll` was not told to install, `pidgen setup` without a terminal, cancelled with Ctrl-C (at a question, during a task or the sign-in wait) or SIGTERM, or stopped by a declined licence | `CLI_USAGE`, `INPUT_INVALID`, `PATH_NOT_PUBLIC`, `WORKER_NOT_FOUND`, `UNSUPPORTED_PLATFORM`, `INSTALL_CONFIRMATION_REQUIRED`, `COSIGN_NOT_FOUND`, `RUNTIME_UNAVAILABLE`, `TERMINAL_REQUIRED`, `SETUP_CANCELLED`, `AGENT_NOT_FOUND`, `AGENT_REQUIRED` |
| 3 | Not authenticated, or not authorized | `AUTH_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_INVALID`, `FORBIDDEN`, `ACCOUNT_MISMATCH`, `ENROLL_NOT_PERMITTED`, `SIGN_IN_NOT_FINISHED`, `AGENT_NOT_SIGNED_IN` |
| 4 | Not found | `NOT_FOUND`, `CREDENTIAL_NOT_FOUND`, `WORKER_NOT_RUNNING`, `WORKER_NOT_INSTALLED`, `INSTRUCTION_NOT_FOUND`, and resource-specific codes |
| 5 | Domain refusal or conflict | server codes such as `ACTIVE_ATTEMPT_EXISTS`, `REOPEN_NOT_JUSTIFIED`, `REQUEST_WITHDRAW_FORBIDDEN`, `REQUEST_ALREADY_CREATED`, `SUBMISSION_KEY_REUSED`, `STEP_SETTLED`, `RUN_PAUSED`, `RUN_HELD`, `INSTRUCTION_ALREADY_DELIVERED`, `DELIVERY_IN_FLIGHT`, `PUBLICATION_RESULT_UNKNOWN`; `WORKER_ALREADY_RUNNING`, `WORKER_CREDENTIAL_PRESENT`, `WORKER_HOST_TAKEN`, `WORKER_NAME_TAKEN`, `PROVENANCE_INVALID`, `RELEASE_UNSUPPORTED`, `PURGE_REFUSED` |
| 6 | A preview digest or acknowledgement is required | `DIGEST_REQUIRED`, `ACKNOWLEDGEMENT_REQUIRED`, `PREVIEW_STALE` |
| 7 | CLI and server API versions are incompatible | `API_VERSION_UNSUPPORTED` |
| 8 | Network failure or timeout, including `--wait` timing out and `pidgen setup` waiting for the worker to connect | `NETWORK`, `TIMEOUT`, `WORKER_NOT_CONNECTED` |

A preview that succeeds exits 0, even when applying it will need acknowledgements; the preview's
`data.required_acknowledgements` says which.

A failed `pidgen setup` step keeps the failing command's own code and exit code; `error.details`
adds `step`, `command`, `error`, `fix`, `steps` and `setup_log` ([Commands](commands.md#setup)).

`pidgen worker start` may also return the worker's exit code, including 128 plus the signal number when
the worker exits because of a signal.

## Exceptions

These do not print an envelope:

- `--help` and `--version`, which print text;
- `pidgen worker start` without `--detach`, which hands the terminal to the worker: the worker's own
  output passes through and `pidgen` exits with the worker's exit code
  ([Workers](workers.md#run-and-check-a-worker));
- `pidgen project doctor --json`, which prints the doctor's report alone, as the server answered
  it, and exits 1 when the setup is the problem; an error under `--json` is the JSON envelope
  ([Commands](commands.md#project-inspect-setup-rehearse-and-doctor)).

A failure before the handoff uses the selected output format. Help and version remain text
regardless of `--format`.

When whatever reads standard output or standard error closes it early, as `pidgen … | head -1`
does, the CLI stops writing to it and exits with the command's own exit code; the reader keeps
what it read before it closed.

## Stability

Exit codes, the envelope's field names, and CLI-defined `error.code` values are public contract.
Removing or renaming any of them, or incompatibly changing output defaults, is a major version change. Server-defined codes are listed in the
public API document ([API compatibility](api-compatibility.md)).
