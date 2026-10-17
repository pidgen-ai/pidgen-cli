---
name: pidgen-retry-run
description: Get a Pidgen ticket moving again after its workflow run failed or stopped advancing. Use when a ticket sits at stage failed, or a run is stranded at in_execution or awaiting_review. Covers reading the run's liveness, deciding whether the runtime will heal it on its own, and taking the recovery the server recommends — retry_run, restart_refinement, replay_from_node or resolve_target_conflict — with pidgen ticket actions and pidgen ticket act. To re-run one node and keep the rest, use pidgen-replay-node; to choose between answering, re-dispatching and filing new work, use pidgen-unstick-ticket.
---

Use `--format json` for structured CLI responses, including when stdout is a terminal.

# Retry a failed ticket

Retrying a ticket means asking the server for a **fresh attempt** of one of its workflow runs. It
is an audited action with an actor and a reason, previewed before it is applied, never an edit of
the ticket. The server decides what can be done: `pidgen ticket actions --format json` lists every action it
offers, whether each is allowed, which one it recommends and what each would do; `pidgen ticket act --format json`
previews one and, with `--apply`, takes it.

> **The runtime heals many stalls by itself.** A run that stops advancing is first *suspected*,
> then given a few bounded repair attempts, and only failed as *stranded* when those change
> nothing. Retrying a run that is mid-repair throws away work the repair was about to reuse.
> **Diagnose before you retry.**

## 1. Find out what the run is doing

```console
pidgen ticket show EXAMPLE-62 --format json
pidgen run list EXAMPLE-62 --format json
pidgen run show WFR-EXAMPLE-70 --format json
```

`pidgen ticket show --format json` gives the ticket's `stage` and open findings. `pidgen run list --format json` lists its runs,
newest first; read the newest run's `status`, `terminal_reason_code` and `liveness`. `pidgen run show --format json`
adds `stranded_cause` and the run's `nodes`, each with its `status` and `latest_attempt`.

| `liveness.state` / `status` | What it means | What to do |
|---|---|---|
| `live` | the run is working | nothing |
| `suspected` | no progress seen; the runtime is about to look | wait a few minutes and read it again |
| `repairing` (`recovery_count` below `recovery_limit`) | self-repair in flight | **wait** — a retry now discards it |
| `stranded` with `cause` `contract_uncovered` | no connected worker can run the next step | fix the workers, not the ticket (§3) |
| `status` `failed`, `terminal_reason_code` `stranded` | repair was tried and changed nothing | **retry** — the case this skill is for |
| `status` `failed`, any other reason | the work failed on its merits | read the failing node first, then retry |

Read the failing node's output before deciding; its `error` often says the retry will fail the
same way:

```console
pidgen run node-output WFR-EXAMPLE-70 implement --format json
```

## 2. Ask the server what it offers

```console
pidgen ticket actions EXAMPLE-62 --family recovery --format json
pidgen ticket actions EXAMPLE-62 --family recovery --run WFR-EXAMPLE-70 --format json
```

`data.actions` lists one decision per action and target. For each, read:

- `state`: `allowed`, or `blocked` with `blocked_by` (`admissible`: the ticket's state does not
  allow it; `authorized`: you may not take it) and `refusal` (`code`, `message`, and `instead`,
  the action to take instead).
- `recommended_reason`: set on the action the server recommends, with its reason.
- `consequence`: `run` is `fresh` (a new run) or `continue`, and each input `class` is `preserve`d
  or `adopt`ed — whether the attempt keeps the run's frozen configuration, contract and ticket
  instructions or takes the current ones.

`pidgen review attention --format json` lists the findings that need a person, with the recommended decision of
each in `recommended_action`; the same decisions appear there.

## 3. Rule out what a retry cannot fix

- **The implementation passes its checks but keeps waiting for a person.** Read the
  implementer's remaining work and the whole completion contract: objective, scope, assumptions,
  referenced plans, context and rework instructions. A baseline review or adoption decision can
  become a hidden gate even when every acceptance criterion is machine-verifiable. Correct it
  only within the user's authorization: define automated evidence requirements and put optional
  product review outside completion (`pidgen-file-ticket`). Retain meaningful checks, including
  proof that the feature under evaluation actually ran. Preserve prior evidence and completed
  work; make the authorized correction explicitly supersede conflicting historical instructions.
  Preview recovery after the edit and verify that the resulting attempt uses the corrected
  ticket inputs. Changed inputs may require replacement rather than selective reuse. Never
  fabricate approval, mutate frozen historical inputs or raise the loop limit to repeat the same
  human blocker.
- **No worker can run it** (`stranded_cause` `contract_uncovered`). A retry strands the same way.
  Check the worker pool with `pidgen worker status --format json`; a connected worker that serves the step lets the
  run continue with no action at all.
- **The failure is in the ticket.** If the failing node's output shows the instructions are wrong,
  edit the ticket (`pidgen ticket edit --format json`) or file new work rather than retrying unchanged input.
- **A step failed and the rest of the run is worth keeping.** Replay that step instead — see
  `pidgen-replay-node`. A retry re-executes everything.

## 4. Choose the action

Take the action the server recommends unless the user asks for another. Typical cases:

| Situation | Action |
|---|---|
| An execution run failed or stranded and its work should start over | `retry_run` — a fresh attempt of the whole run |
| A **Refinery** run failed, and the ticket is still in refinement (`research_needed`, `specification` or `planning`) | `restart_refinement` — a fresh Refinery run with the current configuration, contract and instructions; the old run is kept |
| One step of a finished run went wrong and the steps before it were right | `replay_from_node` — re-runs that step and what depends on it, reusing the rest |
| The delivered pull request conflicts with its target branch | `resolve_target_conflict` — returns the delivery to implementation to merge the target and deliver again |

**`restart_refinement` versus `replay_from_node`.** Both recover a Refinery run. Restart when the
refinement should start again with the current configuration and instructions — after the ticket
was edited, or when every step is suspect. Replay when one step went wrong and the others are
worth keeping. A Refinery run is never retried as a whole: `retry_run` on one is blocked with
`instead: restart_refinement`. A replay the server cannot do is blocked with `instead:
restart_refinement` (for example `NO_REFINERY_RUN` or `REPLAY_DEFINITION_RETIRED`), and refinement
cannot restart past `planning` (`TICKET_PAST_RESEARCH`).

A blocked action is refused before anything is previewed: the command exits 5 (or 3 when you may
not take it) with the refusal's `code` and `message`, and `error.details.instead` names the
alternative. Offer that alternative to the user; do not retry the refused one.

## 5. Preview, then apply

```console
pidgen ticket act EXAMPLE-62 retry_run --run WFR-EXAMPLE-70 --format json
```

The preview changes nothing. Read `data.consequence`, `data.effects` (for a retry, the nodes it
re-executes) and `data.required_acknowledgements`. If `effects` lists expensive work you have
already verified, prefer `replay_from_node`.

Apply only what the user accepted. Pass an acknowledgement only when the preview listed it and the
user accepts what it describes — for example `ambiguous_effects` when a step may already have had
an effect that cannot be confirmed:

```console
pidgen ticket act EXAMPLE-62 retry_run --run WFR-EXAMPLE-70 --apply --acknowledge ambiguous_effects --reason "The worker was lost; the adapter fix has landed." --note "Retried after the worker pool was repaired." --format json
```

The same action for a Refinery run is `pidgen ticket act EXAMPLE-62 restart_refinement --format json`, and
`pidgen ticket retry EXAMPLE-62 --format json` picks `retry_run` or `restart_refinement` for you.

Exit codes: 6 `ACKNOWLEDGEMENT_REQUIRED` names the `missing` codes (ask the user, never add them
yourself); 6 `PREVIEW_STALE` means the run moved since the preview — preview again and re-read it;
5 is a refusal such as `ACTIVE_ATTEMPT_EXISTS` (another run is still active) or `SIBLING_RUN_LIVE`;
3 means you may not take it; 4 means the ticket or run is gone.

Running the same apply again with the same preview and acknowledgements is safe: the CLI derives
the same idempotency key, so the server answers the first execution rather than starting a second.

## 6. Verify

`data.result` is the server's execute result: `command_id`, `ticket_id`, `status` (`applied`, or
`applying` while it settles), `disposition_code`, `workflow_run_id` (the new run) and
`status_url`. Then confirm the new run is being worked, not merely created:

```console
pidgen run show WFR-EXAMPLE-71 --format json
```

A new run whose `liveness.state` is `suspected` again within minutes is the same strand
recurring, not a flake. Go back to §1 and §3; a third attempt will not help.

## Rules

- Recover only through `pidgen ticket actions --format json` and `pidgen ticket act --format json` (or `pidgen ticket retry --format json` and
  `pidgen ticket replay --format json`). Never change a ticket's stage by any other means.
- Diagnose before dispatching. A run mid-repair, or one no worker can serve, is made worse by a
  retry.
- Prefer the narrowest action: replay one node (verified work reused) before retrying the run
  (everything re-executed).
- Never pass an acknowledgement the preview did not list, or one the user has not accepted.
- Read JSON fields and exit codes; do not parse messages.
