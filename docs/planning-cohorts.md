# Planning work in cohorts

When you file several related pieces of work at once — the slices of a design, a feature that
spans many modules — how you group them decides how many pull requests Pidgen opens, which of them
run at the same time, and whether they collide when they merge. `pidgen plan cohorts` helps you get
that grouping right before you file anything. It runs on your machine and sends nothing to the
server.

## Why grouping matters

Every top-level ticket Pidgen executes gets its own workspace and delivers its own pull request.
Tickets with no ordering between them run in parallel, each branched from the same base.

- **Two tickets that edit the same files conflict.** The first pull request merges; the second no
  longer applies cleanly and goes back for rework. With automatic merging turned on, this happens
  without anyone watching — and with many parallel tickets on the same files, every merge sends the
  others back again.
- **A cohort avoids it.** A cohort is one root ticket with child tickets. The children share the
  root's workspace, run one at a time, and ship together in one pull request, so they cannot
  conflict with each other.
- **An edge between two roots orders them.** A root ticket completes only when its pull request has
  merged, so a root that waits for another starts from a base that already contains the other's
  work.

So two pieces of work that touch the same files should either be in one cohort, or be in cohorts
ordered one after the other. `pidgen plan cohorts` works out which, and tells you what it costs.

## Describe your slices

Write a file (YAML or JSON) listing each slice, the existing files it will edit, and the slices it
needs first:

```yaml
hotspots:
  - tests/integration/test_migrations.py
slices:
  - id: auth-tokens
    files: [src/app/auth.py, tests/integration/test_migrations.py]
  - id: auth-scopes
    files: [src/app/auth.py]
    needs: [auth-tokens]
  - id: forge-connections
    files: [src/app/forge/]
    needs: [auth-scopes]
  - id: usage-metering
    files: [src/app/metering.py, tests/integration/test_migrations.py]
```

| Field | Meaning |
|---|---|
| `slices[].id` | Any unique name — the title you will give the ticket works well |
| `slices[].files` | Existing files the slice will change. A path ending in `/` covers everything under it. Leave out files the slice only creates: new files never conflict |
| `slices[].needs` | Slices that must be finished before this one can start |
| `slices[].cohort` | Optional: the cohort you have already put the slice in (see *Check a grouping*) |
| `hotspots` | Optional: files almost every change appends to — a migration list, a route table, a shared index. They are too common to group on; the command warns instead when too many cohorts would edit one at once |
| `max_children` | Optional, default 6: the most slices one cohort takes. A cohort runs its slices one at a time, so a big cohort is a long wait |
| `group_dependencies` | Optional, default `false`: put a slice in the same cohort as the slices it `needs`, instead of ordering their cohorts |

Predicting the files does not have to be exact. Directory-level entries are fine and err on the
safe side.

## Propose a grouping

```console
$ pidgen plan cohorts -f slices.yaml
```

Human output labels the cohorts, edges, summary, warnings and notes, keeping slice identifiers and
shared file paths intact. Use `--format json` to consume the full proposal in a script.

Without `cohort` fields, the command proposes cohorts: each slice joins the cohort it shares the
most files with while that cohort has room, and otherwise starts a new cohort that waits for the
ones it overlaps. For the file above it proposes three cohorts (three pull requests):

| Cohort | Slices | Waits for |
|---|---|---|
| C1 | `auth-tokens`, `auth-scopes` | — |
| C2 | `forge-connections` | C1 |
| C3 | `usage-metering` | — |

`auth-tokens` and `auth-scopes` share `src/app/auth.py`, so they share a cohort. The migration list
is a hotspot, so `usage-metering` does not have to wait for them.

Treat a proposal as a starting point. A grouping you make yourself, by feature area, usually gives
shorter chains — and the command is at its best checking it.

## Check a grouping

Give each slice the cohort you chose:

```yaml
slices:
  - { id: auth-tokens, cohort: identity, files: [src/app/auth.py] }
  - { id: auth-scopes, cohort: identity, files: [src/app/auth.py], needs: [auth-tokens] }
  - { id: forge-connections, cohort: forges, files: [src/app/forge/] }
  - { id: forge-tokens, cohort: forges, files: [src/app/forge/, src/app/auth.py] }
```

The command keeps your cohorts and reports what they need:

- **Edges to add.** Each entry in `edges` is an ordering between two cohorts' roots, with the
  reason: `needs` (a slice depends on a slice in the other cohort) or `overlap` (the two cohorts
  edit the same file and nothing else orders them). Here nothing in `needs` orders the two
  cohorts, but `forge-tokens` edits `src/app/auth.py` like the `identity` slices, so the command
  adds an `overlap` edge: `forges` waits for `identity`.
- **Impossible groupings.** If your cohorts would each have to wait for the other, the command
  stops with `COHORT_CYCLE` and names the two cohorts and the slices responsible. Move one of those
  slices so the dependency runs one way.

## Read the result

Use `pidgen plan cohorts -f slices.yaml --format json` to read structured results even in a
terminal (nonterminal stdout already defaults to JSON). The JSON output's `data` holds:

| Field | What to look at |
|---|---|
| `cohorts[]` | Each cohort's `slices` (in the order they will run), `runs` (one for a single slice, otherwise its slices plus the root's final turn), `blocked_by`, the `shared_files` that put its slices together, and the `hotspots` it touches |
| `edges[]` | The root-to-root orderings to create, each with its `reason` and the slice pairs behind it (`via`) |
| `summary` | `pull_requests` (one per cohort), `longest_chain_runs` and `longest_chain` (the slowest path through the plan), and `ready_at_start` |
| `warnings[]` | `HOTSPOT_CONCURRENCY`: more than two cohorts with no order between them edit the same hotspot. Order some of them, or accept that a merge conflict there may need a rework |
| `notes[]` | Why a slice started its own cohort instead of joining one (the cohort was full, or joining would have ordered two cohorts both ways) |

Compare groupings on two numbers: fewer `pull_requests` means fewer merges to wait for, and a
shorter `longest_chain_runs` means the whole plan finishes sooner. Splitting a large cohort
shortens its chain but adds pull requests; merging small ones does the reverse.

## File the cohorts

Once you are happy with the grouping, file each cohort as one ticket manifest — its root, its
slices as children and the edges among them — with `pidgen manifest apply`, then add the edges
between the roots with `pidgen ticket dep add` (a manifest has one root) before promoting a cohort
that waits on another. The `pidgen-decompose-plan` agent skill does this for you and uses
`pidgen plan cohorts` to check the grouping; see [Skills](skills.md).

## Errors

| Exit | `error.code` | Cause |
|---|---|---|
| 2 | `INPUT_INVALID` | The file is not a slice list, an id is repeated, or a slice `needs` an unknown slice or itself |
| 2 | `DEPENDENCY_CYCLE` | The `needs` form a cycle; `details.cycle` lists it |
| 2 | `COHORT_CYCLE` | The cohorts you gave would each wait for the other |
| 2 | `CLI_USAGE` | `--max-children` is not a positive whole number |

See [Commands](commands.md#plan) for the flags and [Output and exit codes](output-and-exit-codes.md)
for the envelope.
