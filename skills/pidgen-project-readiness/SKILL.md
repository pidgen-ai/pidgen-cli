---
name: pidgen-project-readiness
description: Get a Pidgen Project's repository ready for its Tickets, and later find out whether its workspace setup is why work fails, with pidgen project inspect, setup, rehearse and doctor. Use when someone asks what a repository needs before Pidgen can work in it, to answer the inspection's questions, to write the proposed .pidgen/ setup into a checkout or open it as a pull request, to rehearse that setup on a worker, or when Tickets in a Project keep failing at provision, activate or their tests and the question is whether the setup is to blame. Readiness never gates admission. To retry the failed Tickets afterwards, use pidgen-retry-run.
---

Use `--format json` for structured CLI responses, including when stdout is a terminal.

# Get a Project ready, and ask whether its setup is the problem

When a Project is created, Pidgen reads its repository through the forge and turns what it finds
into **findings**, one per area (languages, services, the database, tests, secrets, tools). From
them it proposes a **workspace setup**: `.pidgen/pidgen.toml` and the scripts it names. A
**rehearsal** proves that setup on a worker in a throwaway workspace before a Ticket needs it.
Weeks later, the **Project doctor** answers one question: is the setup why work in this Project
fails?

Four commands cover it, in the order a Project needs them:

| Step | Command | Changes |
|---|---|---|
| Inspect | `pidgen project inspect <key> --format json` | nothing (an answer inspects again) |
| Set up | `pidgen project setup <key> --format json` | nothing; `--write` writes `.pidgen/` in this checkout, `--pull-request` opens a pull request |
| Rehearse | `pidgen project rehearse <key> --format json` | nothing in the repository; a worker builds and tears down a throwaway workspace |
| Diagnose | `pidgen project doctor <key> --format json` | nothing; `--propose-fix` opens the fix as a pull request |

`<key>` is the Project's ticket-key prefix (such as `STO`) or its id. Readiness never gates
admission: a Ticket runs whether or not the setup is ready, so never hold work back waiting on it.
Name every Ticket by its key when you report to the person.

Ask the person before anything that writes: `--write`, `--pull-request`, `--force` and
`--propose-fix`. Reading, answering a question and rehearsing need no confirmation.

## 1. Read the findings

```console
pidgen project inspect STO --format json
```

`data.inspection.state` is `inspecting` (read it again in a minute), `inspected` or `failed`
(`failure` says why). Each entry in `data.areas` has a `state`:

| `state` | What it means | What to do |
|---|---|---|
| `ok` | nothing to set up | nothing |
| `proposed` | the proposal covers it (`proposal` says how) | review it in step 2 |
| `needs_you` | only a person can settle it (`ask` says what) | tell the person |
| `cannot_tell` | the repository does not say | ask the person, or rehearse and see |
| `pending` | not read yet | read it again |

`data.questions` lists what the inspection could not answer; an open one has `answer` null, and
offers `choices`, a `default` and the `evidence` it found. Ask the person, then answer it; the
repository is inspected again and `data.inspection.state` is `inspecting`:

```console
pidgen project inspect STO --answer stripe-test-key=skip --format json
```

`--answer` repeats, one per question. An unknown question exits 2 with
`READINESS_QUESTION_UNKNOWN`.

## 2. Review the proposed setup, then write it or propose it

```console
pidgen project setup STO --format json
```

`data` is the proposal: its `state` (`draft`, `pull_request_open` or `merged`), its `files` (each
`path`, `executable` and `bytes`), its `assumptions` and its `pull_request`. Show the person the
files and the assumptions. No proposal yet exits 4 with `READINESS_PROPOSAL_NOT_FOUND`: inspect
first.

Then, with the person's agreement, one of:

```console
pidgen project setup STO --pull-request --format json
pidgen project setup STO --write --format json
```

- `--pull-request` opens the setup as a pull request through the Project's forge connection;
  `data.pull_request` has its `url`, `number` and `branch`. `FORGE_NOT_CONNECTED` (exit 5) means
  the Project has no forge: use `--write`. `READINESS_QUESTIONS_OPEN` (exit 5) means a question
  is still open: answer it in step 1.
- `--write` extracts the files under `.pidgen/` at the root of the git checkout you run it in,
  scripts executable. `data.files` gives each one's `status` (`created`, `updated` or
  `unchanged`). Outside a checkout it exits 2 with `NOT_A_CHECKOUT`. An existing `.pidgen/` that
  the write would change at all (a file created in it, replaced, or given another mode) exits 5
  with `FILES_EXIST` and writes nothing; `error.details.paths` lists those files. Writing the same
  proposal again changes nothing and exits 0. Show the person the differences; add `--force` only
  when they say to replace them. Files of their own under `.pidgen/` are never touched.
  The written files are the person's to commit and push.

## 3. Rehearse it

```console
pidgen project rehearse STO --format json
pidgen project rehearse STO --ref pidgen/setup --format json
```

A worker builds a throwaway workspace from the proposal's branch (or `--ref`), runs provision,
activate, the database step and the tests, and tears it down. The command follows it to the end,
which takes minutes; `data` is the settled rehearsal with its `steps` (each `step`, `state`,
`exit_code`, `duration_seconds`) and its `verdict`, one sentence.

- A failed rehearsal exits 1 with `REHEARSAL_FAILED`; `error.details.rehearsal.verdict` names the
  step that failed, why, and the fix. Tell the person, change the setup, and rehearse again.
- One still running after 30 minutes exits 8 with `TIMEOUT` and goes on without you; read it
  later with step 1's command, whose `data.rehearsal` is the latest rehearsal.
- `REHEARSAL_IN_PROGRESS` (exit 5): one is already running; read it, do not start another.
  `NO_ELIGIBLE_WORKER` (exit 5): no connected worker can run the Project; see pidgen-setup-worker.
- `--no-follow` returns as soon as the rehearsal is queued.

## 4. When work keeps failing: run the doctor

```console
pidgen project doctor STO --format json
pidgen project doctor STO --since 14d --format json
```

The doctor reads the setup files on the base branch, the connected workers and the last seven
days of runs (`--since` takes days or weeks, such as `14d` or `2w`, up to 90 days). It changes
nothing. Its report has a `verdict` (`setup`, `code` or `unclear`) and a `summary`, the verdict
as one sentence with its evidence, then six `groups` (`setup_files`, `workers`, `secrets`, `workspaces`, `tests`,
`drift`), each with its `checks`: a `state` (`ok`, `needs_you` or `failed`), a `summary`, and for a
failure its `evidence`, the `tickets` by key, the `cause` (the change that introduced it) and the
`fix`.

- **The setup is the problem**: it exits 1 with `SETUP_IS_THE_PROBLEM`, and the report is in
  `error.details.report`. Tell the person the summary and each failed check. When
  `error.details.report.fix.template` is not null the doctor can write the fix; with the person's
  agreement, open it as a pull request, then read `fix.pull_request`:

  ```console
  pidgen project doctor STO --propose-fix --format json
  ```

  When `fix.template` is null, `fix.summary` and each failed check's `fix` name the file and the
  change for the person to make. Once the fix is on the base branch, the Tickets in `fix.retry`
  need a fresh attempt: preview each with `pidgen ticket act STO-33 retry_run --format json`,
  and follow pidgen-retry-run to take it. Do not retry before the fix is merged; the new workspace
  would fail the same way.
- **The setup is not the problem** (`code`): it exits 0, and `data` is the report. The failures
  are in the Tickets' own code; `data.failed_tickets` lists them by key. Read each with
  `pidgen ticket show STO-40 --format json` and work on the code, not the environment.
- **The doctor cannot tell** (`unclear`): it exits 0 too, since only `setup` blames the setup;
  `code` or `unclear`, the command exits 0. `summary` and the checks marked `needs_you` say which
  failures it could not classify, with `data.failed_tickets` by key. Report them as unexplained,
  show the person the evidence, and do not change the setup or the code on the doctor's say-so.

In either case, `rehearse` not null means the last rehearsal is out of date and says why; offer
to rehearse again (step 3). A failure the doctor could not classify is still listed: report it as
it is, never as settled. The doctor never retries, rebuilds or writes anything without
`--propose-fix`, and neither should you on its say-so alone.

For a script, `--json` prints the report alone, exactly as the server answered it, with the same
exit status.
