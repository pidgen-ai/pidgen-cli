---
name: pidgen-query-tickets
description: Find and read Pidgen tickets, epics, projects, runs and their state with read-only pidgen commands. Use whenever you need to look up a ticket by key or id, list or filter tickets by stage, project, text or open intervention, see which project or Epic (its parent_ticket_id) a ticket belongs to, read its dependencies, runs, node outputs and the actions it allows, or list what needs a person's attention. Changes nothing; to file work use pidgen-file-ticket, to recover a run use pidgen-retry-run.
---

Use `--format json` for structured CLI responses, including when stdout is a terminal.

# Query tickets

Every command here reads only. Each prints one JSON envelope: read `data` for the answer and branch
on the exit code and `error.code` (4 means not found, 3 means you may not read it). A ticket is
named by its key, such as `EXAMPLE-12`, or its id (`TKT-…`). An Epic is a ticket of kind `epic`,
named the same way, such as `EXAMPLE-40`.

## One ticket

```console
pidgen ticket show EXAMPLE-12 --format json
```

`data` is the ticket — `ticket_key`, `id`, `title`, `objective`, `stage`, `priority`,
`kind` (`task`, `story` or `epic`), `project_id`, `parent_ticket_id` (the Epic or Story it sits
in), its acceptance criteria and their evidence, its `delivery` and open findings — plus `prerequisites`: whether it is `ready` to run, its
`readiness_blockers` explained, and the unfinished `blocking_prerequisites` holding it.

## List and filter tickets

```console
pidgen ticket list --format json
pidgen ticket list --stage awaiting_review --format json
pidgen ticket list --project EXAMPLE --stage failed --format json
pidgen ticket list --query scheduler --format json
pidgen ticket list --intervention execution_failed --format json
pidgen ticket list --kind epic --format json
```

`data` is every matching ticket you can see, newest first; the CLI follows every page. Filters
combine:

- `--stage`: `backlog`, `research_needed`, `specification`, `planning`, `implementation_ready`,
  `in_execution`, `awaiting_review`, `delivered`, `completed`, `failed` or `abandoned`.
- `--project`: the project's id or key prefix.
- `--query`: text in the key, id, title or objective, ignoring case (at most 20 results).
- `--intervention`: tickets waiting on an open intervention of that type, such as
  `clarification_needed`, `review_required` or `execution_failed`.
- `--kind`: `task`, `story` or `epic`. Without it the list leaves Epics out; `--kind epic` lists
  only Epics.

There is no Epic filter on the ticket list; list an Epic's members with `pidgen epic dag show --format json`
(below), or read a ticket's `parent_ticket_id`.

## Projects and Epics

```console
pidgen project list --format json
pidgen project show EXAMPLE --format json
pidgen ticket list --kind epic --project EXAMPLE --format json
pidgen ticket show EXAMPLE-40 --kind epic --format json
pidgen epic dag show EXAMPLE-40 --format json
```

`pidgen ticket show --kind epic --format json` reads an Epic like any ticket, with its `branch_mode`,
`feature_branch`, `target_date` and merge policy, and refuses a ticket that is not an Epic
(`TICKET_KIND_MISMATCH`, exit 4). `pidgen epic dag show --format json` reads the Epic's dependency graph: what it
waits for and what waits for it as `nodes` and `edges`, and its members as `pieces` (each with
`ticket_key`, `title` and `stage`) with the `piece_edges` between them. `pidgen epic list --format json` and
`pidgen epic show --format json` are the same reads under their older names.

## Dependencies

```console
pidgen ticket dep list EXAMPLE-13 --format json
```

`data.blocked_by` are the tickets it waits for, `data.blocks` the tickets waiting for it, and
`data.inherited_blocked_by` the `blocks` edges declared on its ancestors, which hold it too.

## Runs and node outputs

```console
pidgen run list EXAMPLE-12 --format json
pidgen run show WFR-EXAMPLE-1 --format json
pidgen run node-output WFR-EXAMPLE-1 implement --format json
```

`pidgen run list --format json` gives the ticket's workflow runs, newest first, each with its `status`,
`terminal_reason_code` and `liveness` (`live`, `suspected`, `repairing` or `stranded`).
`pidgen run show --format json` adds `stranded_cause` and the run's `nodes`. `pidgen run node-output --format json` returns one
node's attempts and its latest `output`; read the output, not just the status.

## What needs a person, and what can be done

```console
pidgen review list --type clarification_needed --format json
pidgen review attention --format json
pidgen ticket actions EXAMPLE-12 --format json
```

`pidgen review list --format json` lists tickets waiting on an intervention of a type. `pidgen review attention --format json`
lists the open findings that need a person's decision — those with a recommended action first,
then the oldest — each with its `target`, its action decisions and the recommended one in
`recommended_action`. `pidgen ticket actions --format json` lists what a ticket, its runs and its dependencies
allow, why a blocked action is blocked, and which one the server recommends. Taking an action is
not a query: see `pidgen-retry-run`, `pidgen-replay-node` and `pidgen-unstick-ticket`.

## Rules

- Read through `pidgen` commands only; they see exactly what your Account may see.
- Do not infer state from messages: read the JSON fields.
- A query never changes anything. Never use one as a step in changing a ticket's state.
