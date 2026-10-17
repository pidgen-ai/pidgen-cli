---
name: pidgen-manage-epics
description: Create and populate a Pidgen Epic — an epic-kind ticket — set its branch and merge policy, place tickets in it by their parent_ticket_id, and wire dependency edges between tickets and Epics, using the CLI's ticket commands. Also files a Domain Epic, an Epic in a domain that tracks work across the domain's projects. Use when asked to create or organize an epic, file an epic that spans projects, set its merge policy, move tickets into or out of one, or make one ticket or Epic wait for another. An Epic is not a shared workspace — tickets that consume each other's changes or edit the same files need a shared parent (pidgen-decompose-plan), and cohorts are ordered by edges between their roots.
---

Use `--format json` for structured CLI responses, including when stdout is a terminal.

# Create an Epic

An Epic is a ticket of kind `epic`: a delivery program in one project that holds Stories and Tasks
and does no work of its own. It is filed, listed, read and edited with the ticket commands and
`--kind epic`, and a ticket belongs to it through its `parent_ticket_id`. It has real effects on
behaviour:

- **Membership.** A Story or Task is in an Epic when its `parent_ticket_id` names the Epic. An Epic
  has no parent of its own.
- **Ordering.** `blocks` edges gate dispatch whether or not either end is in an Epic: a ticket is
  not ready until every `blocks` prerequisite reaches `completed`. Either end of an edge may be an
  Epic.
- **Integration branch (optional).** An Epic's `branch_mode` says where its members deliver:
  `project_base` (the default), `create_new` (a new feature branch, cut from the latest project
  base when a member first needs it) or `target` (an existing branch, reused as it is). It is
  fixed when the Epic is created.
- **Merge policy (optional).** `auto` lets Pidgen merge its members' verified pull requests
  itself; `manual` leaves the merge to a person; `null` inherits the project's.

Work that spans projects goes under a **Domain Epic** instead, filed in a domain rather than a
project (§6).

Creating an Epic starts no work and spends nothing. The commitment comes when tickets are filed
into it (`pidgen-file-ticket`).

**An Epic is not a shared delivery workspace.** Every root in it gets its own workspace and pull
request, all branched from the same base. When a later ticket consumes an earlier one's code,
schema, APIs or tests — or when two tickets edit the same files — they belong under one parent:
`pidgen-decompose-plan` owns that judgment and the child-plan command. Epic members that edit the same
files at the same time conflict at merge.

An Epic is numbered like any ticket: its **key**, such as `EXAMPLE-40`, which you cite to people
and pass to commands, and its **id** (`TKT-…`), which a member's `parent_ticket_id` holds. Every
command accepts either.

## 1. Pick the project and check for duplicates

```console
pidgen project list --format json
pidgen ticket list --kind epic --project EXAMPLE --format json
```

`pidgen ticket list --format json` leaves Epics out unless `--kind epic` asks for them. An Epic belongs to
exactly one project. Nothing prevents two Epics with the same title, so check the list first.
Always name the project.

## 2. Create the Epic

```yaml
title: Admin UI
description: Everything the operator-facing app needs to ship.
project_id: EXAMPLE
branch_mode: create_new
feature_branch: feature/admin-ui
target_date: '2026-12-31T00:00:00Z'
```

```console
pidgen ticket create --kind epic -f epic.yaml --format json
```

Only `title` is required; `data` carries the new Epic's `ticket_key` and `id`. Cite the key from
here on.

- `description` is stored as the Epic's objective; send it or `objective`, not both.
- `target_date` is documentation, not an enforced deadline. Send a full timestamp with `Z`.
- `branch_mode: create_new` with an optional `feature_branch` name, or `target` with a required
  one, needs the project's forge connection. The name is checked on the forge when the Epic is
  created (`EPIC_BRANCH_REFUSED` when it is taken, missing or illegal; nothing is created). The
  branch cannot be changed later, so set it now if the user asks for an integration branch.
- An Epic refuses the fields of work it does not do — `team_member_id`, `workflow_type`,
  `approval_mode`, `acceptance_criteria`, `start_refinement`, `required_capabilities`,
  `estimated_complexity` and `parent_ticket_id` (`EPIC_FIELD_REFUSED`, `EPIC_HAS_NO_PARENT`).

`pidgen epic create -f epic.yaml --format json` is the same command under its older name.

### Merge policy: set it only with the user

`merge_policy` is `manual`, `auto`, or `null` to inherit the project's. Set it in the Epic's file,
or change it later with an edit file holding only `merge_policy`:

```console
pidgen ticket edit EXAMPLE-40 --kind epic -f merge-policy.yaml --format json
```

`merge_policy: null` inherits again. It takes effect only while the project allows automatic
merging, and a member's own `merge_policy` overrides the Epic's.

Under `auto`, each root's verified pull request is merged and the ticket completed without a
person. A pull request the forge reports as conflicting goes back to implementation to merge its
target (the `resolve_target_conflict` repair), and every overlapping pull request that lands first
can send it back again, until the return budget is spent and a person must decide. So an `auto`
Epic holding many roots that edit the same files and run at once is the setup that loops: group
related work into cohorts with `pidgen-decompose-plan` and order the cohorts root to root (§4) first.

## 3. Put tickets in the Epic

New tickets: name the Epic when they are created. A ticket file names it as `parent_ticket_id`;
a ticket manifest or an intent names it as `epic_id`, which becomes the ticket's
`parent_ticket_id` (see `pidgen-file-ticket`). The Epic must be in the ticket's project.

Existing tickets: move them, which sets each ticket's `parent_ticket_id` and is recorded in its
history:

```console
pidgen ticket move EXAMPLE-12 --epic EXAMPLE-40 --format json
pidgen ticket move EXAMPLE-13 --no-epic --format json
```

`data.move.moved` is false when the ticket was already there. Only a ticket without a parent or a
member of an Epic moves, and only before its execution starts. An Epic of another project is
`PARENT_PROJECT_MISMATCH` and a ticket that is not an Epic `PARENT_NOT_EPIC` (both exit 2).

A root created with `pidgen-file-ticket` waits in `backlog` until it is promoted, so add its edges
before promotion. Children are written with their edges in one step by `pidgen plan apply --format json`
(`pidgen-decompose-plan`).

## 4. Wire dependency edges (optional)

To make one ticket wait for another, declare it on the waiting ticket:

```console
pidgen ticket dep add EXAMPLE-13 --on EXAMPLE-12 --format json
pidgen ticket dep list EXAMPLE-13 --format json
```

`EXAMPLE-13` waits for `EXAMPLE-12`. Either may be an Epic: to make a whole program wait for
another, add the edge between the two Epics. `pidgen epic edge add EXAMPLE-40 --from EXAMPLE-12
--to EXAMPLE-13 --format json` is the same edge under the older name. `--type` is `blocks` (the default),
`informs` or `parallel_safe`; **only `blocks` gates dispatch**. Adding an edge that exists returns
it.

`blocks` clears when the prerequisite reaches `completed`:

- **A root** completes only once its delivery has landed, so an edge between two roots is a merge
  gate: the waiting root branches from a base that already holds the prerequisite's changes. This
  is how cohorts are ordered.
- **A child** completes when its commit is accepted in its root's shared workspace, long before
  that pull request merges. An edge from a child to a ticket outside its cohort is refused with
  `DEPENDENCY_CROSSES_COHORT`; add it between the two roots.

An edge orders roots; it does not stop two unordered roots editing the same files. Chain them with
an edge or put them in one cohort.

The server's refusals keep their codes and exit 5: `DEPENDENCY_CYCLE` (with the cycle),
`DEPENDENCY_SELF_EDGE`, `DEPENDENCY_CROSS_PROJECT`, `DEPENDENCY_CROSSES_COHORT` and
`DEPENDENCY_TARGET_FROZEN` (the waiting ticket has started executing; its edges can no longer
change). An unknown ticket is `DEPENDENCY_ENDPOINT_NOT_FOUND` (exit 4).

For work that spans Projects, use `pidgen-decompose-plan`, "Work that spans Projects": give the provider
change its own ticket and build the consumer against the agreed contract, and track the projects'
work together under a Domain Epic (§6). An Epic cannot enforce cross-Project ordering. Record live integration and its release prerequisites in the external QA
plan, outside ticket completion.

A failed or abandoned prerequisite blocks forever: `blocks` clears only on `completed`. Remove the
edge before the waiting ticket executes with `pidgen ticket dep rm EXAMPLE-13 --on EXAMPLE-12 --format json`, or
take the server's `remove_dependency` action, which it recommends when a prerequisite can no longer
complete:

```console
pidgen ticket actions EXAMPLE-13 --family ticket_control --format json
pidgen ticket act EXAMPLE-13 remove_dependency --prerequisite TKT-EXAMPLE-12 --format json
pidgen ticket act EXAMPLE-13 remove_dependency --prerequisite TKT-EXAMPLE-12 --apply --reason "The prerequisite was abandoned." --format json
```

## 5. Verify

```console
pidgen ticket show EXAMPLE-40 --kind epic --format json
pidgen epic dag show EXAMPLE-40 --format json
pidgen ticket show EXAMPLE-13 --format json
```

`pidgen ticket show --kind epic --format json` refuses a ticket that is not an Epic (`TICKET_KIND_MISMATCH`,
exit 4). `pidgen epic dag show --format json` reads the Epic's dependency graph: what it waits for and what
waits for it as `nodes` and `edges`, and its members as `pieces` with the `piece_edges` between
them. A member's `parent_ticket_id` names the Epic, and its `prerequisites` in
`pidgen ticket show --format json` say whether it is `ready` and which prerequisites hold it.

## 6. File a Domain Epic for work across projects

A **domain** groups projects, and domains nest; every Account has an Account domain that covers
every project. A **Domain Epic** is an Epic filed in a domain rather than in one project. It holds
Project Epics, Stories and Tasks from the projects its domain covers, and may sit under a Domain
Epic of a parent domain. It is numbered from the domain's key (`EXAMPLE-12` style keys), and it
owns no branch: it is a tracking parent, not a workspace, and each project's work under it still
gets its own workspace and pull request in its own project. Keep work in one project in a Project
Epic (§1 to §5).

Find the domain that covers every project the work touches, and check its Epics for a duplicate:

```console
pidgen domain list --format json
pidgen domain epics EXAMPLE --format json
```

`pidgen domain list --format json` gives each domain's `key`, `name`, `archived` flag and the `projects` and
`domains` it contains, the Account domain first. `pidgen domain epics --format json` gives the domain's open
Epics, its subdomains' included (`--state finished` for finished ones): each entry's `epic`, its
work grouped by project in `projects`, and `hidden`, how many of its tickets you cannot see.

File the Domain Epic with a file that names no project and no branch:

```yaml
title: Checkout across payments and cards
description: One checkout across the payment and card projects.
target_date: '2026-12-01T00:00:00Z'
```

```console
pidgen ticket create --kind epic --domain EXAMPLE -f domain-epic.yaml --format json
```

Never give `branch_mode` or `feature_branch` (nor `project_id`): the domain stands in for the
project, and the CLI refuses such a file with `INPUT_INVALID` (exit 2) and sends nothing.
`pidgen epic create --domain EXAMPLE -f domain-epic.yaml --format json` is the same command under its older
name. `data` carries the Domain Epic's `ticket_key` and `id`; cite the key from here on. To put it
under a Domain Epic of a parent domain, name that Epic as its `parent_ticket_id` in the file.

Then place each project's work under it by `parent_ticket_id`, as for any Epic (§3): a ticket file
names the Domain Epic as its `parent_ticket_id`, a ticket manifest names it as its `epic_id`, which
becomes the root's `parent_ticket_id`, and an existing ticket moves in with
`pidgen ticket move EXAMPLE-31 --epic EXAMPLE-12 --format json`. File one cohort per project with
`pidgen-decompose-plan`, "Work that spans Projects"; dependency edges still cannot cross projects.

The server's refusals keep their codes:

- `PARENT_OUTSIDE_DOMAIN`: the ticket's project is not in the domain's coverage. If you maintain
  the domain, add the project with `pidgen domain project add EXAMPLE PAY --format json` and file again;
  otherwise choose another domain that covers it.
- `DOMAIN_HAS_NO_PROJECTS` (exit 5): the domain contains no project yet. Add one, or choose
  another domain.
- `EPIC_FIELD_REFUSED` (exit 2): the file names a field an Epic refuses, such as a branch.
- `DOMAIN_NOT_FOUND` (exit 4): a typo in the domain's key or id.
- A 403 (exit 3) means you do not maintain the domain (its Maintainers and the Account's Owners and
  Administrators may file one) or the Account's plan lacks domains. Report it to the person; do
  not file the work in a single project instead without asking.

## Gotchas

| Symptom | Cause |
|---|---|
| `PROJECT_NOT_FOUND` (exit 4) | a typo in the project's id or prefix |
| `PARENT_PROJECT_MISMATCH` or `EPIC_PROJECT_MISMATCH` filing or moving a ticket | the Epic belongs to another project |
| `PARENT_NOT_EPIC` (exit 2) | the `parent_ticket_id` or `--epic` names a Story or Task, not an Epic |
| `TICKET_KIND_MISMATCH` (exit 4) | `--kind epic` was given a ticket that is not an Epic |
| An Epic is missing from `pidgen ticket list --format json` | the list leaves Epics out; add `--kind epic` |
| No feature branch | `branch_mode` was `project_base`; it cannot be changed later |
| An edge was added, the ticket still dispatches | its type is not `blocks`, or the prerequisite already completed |
| Roots' pull requests keep coming back for rework | the Epic is `auto` and parallel roots edit the same files — regroup the unstarted ones (`pidgen-decompose-plan`) |
| A ticket never becomes ready | a prerequisite has not completed, or failed or was abandoned |
| `PARENT_OUTSIDE_DOMAIN` placing work under a Domain Epic | the ticket's project is not in the domain's coverage (§6) |
| `DOMAIN_HAS_NO_PROJECTS` (exit 5) filing a Domain Epic | the domain contains no project |
