---
name: pidgen-unstick-ticket
description: Get a Pidgen ticket through the pipeline again — when its refinement or execution run is dead, when it is stuck and you are deciding between answering it, re-dispatching refinement, recovering a run, reopening it and filing new work. Covers restart_refinement (the refinement re-dispatch, for tickets at research_needed, specification or planning) versus replay_from_node, and resolve_target_conflict, through pidgen ticket actions and pidgen ticket act. There is no reset that deletes a ticket's history.
---

Use `--format json` for structured CLI responses, including when stdout is a terminal.

# Re-run a ticket

A ticket that needs to go through the pipeline again has several possible answers, and they are
not interchangeable. Work down this list: the first one that applies is the right one, and reaching
for a later one first usually destroys the evidence you needed.

Nothing here deletes a ticket's history. Every step is an action the server previews and records
with an actor and a reason. There is no "reset" that rewrites a ticket's stage or deletes its runs,
documents or workspace, and you must not look for one.

## 1. Is it parked, waiting on a person?

A refinement gate that cannot proceed **parks** its run and asks a question instead of ending. The
ticket is not broken and the run is alive: it is waiting for an answer.

```console
pidgen review list --format json
pidgen api get /tickets/EXAMPLE-7/clarification --format json
```

Bring the questions to the user and answer with their words:

```yaml
answers:
  login_method: password
note: Agreed with the product owner.
```

```console
pidgen ticket clarify EXAMPLE-7 -f answers.yaml --format json
```

Refinement resumes. Use `outcome: abandoned` when nobody can answer. A result with a
`dispatch_error` means the answers were saved but the run could not resume yet: do not answer
again; the server retries. `pidgen intent respond --format json` answers an intent's questions instead (see
`pidgen-file-ticket`).

## 2. Does something dispute the ticket's recorded state?

The runtime sweeps for tickets whose stage its evidence cannot support, and for decisions waiting
on a person:

```console
pidgen review attention --format json
```

Each entry in `data.findings` names the ticket, what is wrong (`code`, `detail`), its `target` and
its action decisions, with the recommended one in `recommended_action` (or null). A ticket that is
`completed` without a delivery is not a candidate for re-running: its recommended action is
`reopen_for_delivery`, which returns it to `awaiting_review` where recovery works. See
`pidgen-replay-node`, §3.

## 3. Is the run dead, but the history worth keeping?

Ask the server what it offers for the ticket and its runs:

```console
pidgen run list EXAMPLE-52 --format json
pidgen ticket actions EXAMPLE-52 --family recovery --format json
```

Each decision has a `state` (`allowed` or `blocked`, with the `refusal` and the action to take
`instead`), a `recommended_reason` on the one the server recommends, and a `consequence`. Then:

- **Refinement is dead: re-dispatch it with `restart_refinement`.** It starts a fresh Refinery run
  with the current configuration, contract and ticket instructions, and deletes nothing — the old
  run and its events are kept. It is offered only while the ticket is still in refinement, at
  `research_needed`, `specification` or `planning`, with no live Refinery run and no open
  clarification; past `planning` it is refused with `TICKET_PAST_RESEARCH`, and with an open
  question with `CLARIFICATION_PENDING` (answer it, §1).

  ```console
  pidgen ticket act EXAMPLE-52 restart_refinement --format json
  pidgen ticket act EXAMPLE-52 restart_refinement --apply --reason "The research gate was fixed; refine again." --format json
  ```

- **One refinement or execution step went wrong: `replay_from_node`.** Choose it over
  `restart_refinement` when the steps before the wrong one are worth keeping: it reuses the run's
  verified work and re-runs that step and what depends on it. When the server cannot replay, the
  decision is blocked with `instead: restart_refinement`. See `pidgen-replay-node`.

- **An execution run failed: `retry_run`**, a fresh attempt that inherits nothing. A Refinery run is
  not retried as a whole: its `retry_run` is blocked with `instead: restart_refinement`. See
  `pidgen-retry-run`.

- **The delivered pull request conflicts with its target branch: `resolve_target_conflict`**
  ("Resolve merge conflicts"). It returns the delivery to implementation to merge the target and
  deliver again; nothing is re-run from scratch. It is refused with `PULL_REQUEST_MERGEABLE` when
  the forge reports no conflict.

Every action follows the same preview and apply:

```console
pidgen ticket act EXAMPLE-52 resolve_target_conflict --format json
pidgen ticket act EXAMPLE-52 resolve_target_conflict --apply --reason "The target branch moved." --note "Merge main and deliver again." --format json
```

Read the preview's `consequence`, `effects` and `required_acknowledgements`, and pass with
`--acknowledge` only codes the preview listed and the user accepted. A blocked decision exits 5
(or 3 when you may not take it) with its refusal's `code`, `message` and `instead`; offer the
alternative rather than retrying.

## 4. Do you actually want a blank ticket?

You are iterating on prompt or workflow changes and want a clean full pipeline each time. There is
no supported way to blank a ticket, because "blank" means deleting the research and specification
that usually explain *why* it is stuck, and they do not come back.

Create a new ticket instead: it keeps the failed attempt available for comparison and risks no
live workspace.

```console
pidgen ticket template -o ticket.yaml --format json
pidgen ticket create -f ticket.yaml --format json
```

When the old ticket should not run any more, cancel it (`pidgen ticket cancel --format json`, preview first), naming
the new one with `--superseded-by`.

## Verify after a re-dispatch

```console
pidgen run list EXAMPLE-52 --format json
pidgen run show WFR-EXAMPLE-53 --format json
```

The execute result's `data.result.workflow_run_id` names the run the action started, and
`data.result.status` is `applied` (or `applying` while it settles). The newest run in
`pidgen run list --format json` should be `live`; its nodes appear in `pidgen run show --format json` as they start. Nothing
executes without a connected worker that serves the steps: check with `pidgen worker status --format json`. A fresh
refinement does real work and can take many minutes.

## Rules

- Never change a ticket's stage, or delete its runs or workspace, by any means. Re-run through the
  actions the server offers.
- Prefer, in order: answer it, reopen it, re-dispatch or recover a run, file new work.
- Never pass an acknowledgement the preview did not list, or one the user has not accepted.
- Read JSON fields and exit codes; do not parse messages.
