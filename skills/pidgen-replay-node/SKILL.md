---
name: pidgen-replay-node
description: Re-run one node of a Pidgen workflow run as a new attempt that reuses the verified work outside it — when a node failed, or when it succeeded while the effect it exists to produce did not happen (a delivery that did not deliver, a verification whose evidence never landed). Also covers reopening a completed ticket whose delivery cannot be proven, which makes the replay possible, and choosing replay_from_node over restart_refinement for a Refinery run. Uses pidgen ticket actions and pidgen ticket act. For a fresh attempt of the whole run, use pidgen-retry-run.
---

Use `--format json` for structured CLI responses, including when stdout is a terminal.

# Replay a workflow node

Replaying a node starts a **new attempt** that reuses every verified result outside the node's
downstream closure and re-executes the node and what depends on it. It never edits history: the
source run, its node attempts and its events stay as they were. The server decides whether a
replay is possible: `pidgen ticket actions --format json` lists the `replay_from_node` decisions it offers and why
a blocked one is blocked; `pidgen ticket act --format json` previews one and, with `--apply`, takes it.

| | What it is |
|---|---|
| **Node replay** (`replay_from_node`) | **this skill** — a new attempt reusing verified upstream work |
| Run retry (`retry_run`) | a fresh execution inheriting nothing — `pidgen-retry-run` |
| Refinement restart (`restart_refinement`) | a fresh Refinery run with the current configuration — `pidgen-retry-run` |

## 1. Diagnose before you replay

Never replay on a hunch about which node is wrong.

```console
pidgen ticket show EXAMPLE-4 --format json
pidgen run list EXAMPLE-4 --format json
pidgen run show WFR-EXAMPLE-4 --format json
pidgen run node-output WFR-EXAMPLE-4 deliver --format json
```

`pidgen ticket show --format json` gives the ticket's `stage`, its `delivery` (the proof of delivery, `null` when
there is none) and its open findings. `pidgen run show --format json` lists the run's `nodes` with their `status`.
**Read the output, not just the status**: `pidgen run node-output --format json` returns the node's `output` — a
node whose status is `completed` but whose result says nothing was delivered is a node that
succeeded and a delivery that did not. Replay the node that *produced* the wrong result, not the
one that noticed it.

## 2. Pick the route

| Ticket stage | Source run | Route |
|---|---|---|
| `failed` | failed, terminated or cancelled | replay the node (§4) |
| `awaiting_review` | completed | replay the node; the preview asks you to acknowledge `completed_source` |
| `completed`, delivery proven | any | **Stop.** The work is done; a replay would be rework |
| `completed`, delivery unproven | any | **Reopen first** (§3), then replay |
| any | a run still active | **Stop.** Let it finish, or stop it with `terminate_run`, first |

For a **Refinery** run, choose between `replay_from_node` and `restart_refinement`:

- `replay_from_node` when one step went wrong and the steps before it are worth keeping. It reuses
  the run's frozen configuration and instructions.
- `restart_refinement` when refinement should start again with the current configuration, contract
  and ticket instructions — for example after the ticket was edited. It is offered only while the
  ticket is at `research_needed`, `specification` or `planning`.

A replay the server cannot do is blocked with the alternative in `refusal.instead`: for example
`REPLAY_REQUIRES_PRODUCER` (`instead: replay_from_node` — replay the producing node),
`NO_REFINERY_RUN` or `REPLAY_DEFINITION_RETIRED` (`instead: restart_refinement`).

When the delivered pull request conflicts with its target branch, replaying the delivery will not
merge it: take `resolve_target_conflict` ("Resolve merge conflicts"), which returns the delivery
to implementation to merge the target and deliver again.

## 3. Reopen a completed ticket that cannot prove delivery

A completed ticket can be reopened only while its completion cannot be proven — no delivery
evidence, or no successful execution run. A healthy ticket cannot be reopened, so this is a repair,
not an un-complete button. `pidgen review attention --format json` lists such tickets, each with its
`recommended_action` (`reopen_for_delivery`).

```console
pidgen ticket actions EXAMPLE-58 --family recovery --format json
pidgen ticket act EXAMPLE-58 reopen_for_delivery --format json
pidgen ticket act EXAMPLE-58 reopen_for_delivery --apply --reason "The deliver step failed; the branch was never merged." --format json
```

(`pidgen ticket reopen EXAMPLE-58 --format json` is the same repair through its own preview and apply.) The ticket
returns to `awaiting_review` and its delivery record is superseded, so the replay in §4 becomes
possible. `REOPEN_NOT_JUSTIFIED` means the completion holds and there is nothing to repair;
`REOPEN_REQUIRES_HUMAN` means only a person may withdraw it.

## 4. Preview the replay

```console
pidgen ticket actions EXAMPLE-4 --family recovery --node deliver --format json
pidgen ticket act EXAMPLE-4 replay_from_node --node deliver --run WFR-EXAMPLE-4 --format json
```

The decision's `state` must be `allowed`; a blocked one exits 5 (or 3) with the refusal's `code`,
`message` and `instead`. The preview changes nothing. Read:

- `data.effects`: the nodes it re-executes and the nodes it reuses. If it re-executes work you
  meant to keep, you picked the wrong node.
- `data.consequence`: `run` (`continue` or `fresh`) and whether each input is `preserve`d or
  `adopt`ed. A changed ticket makes the replay start a fresh run that reads the current ticket.
- `data.required_acknowledgements`: for example `completed_source` (replaying a completed run
  repeats completed work) or `ambiguous_effects` (a step may already have had an effect that
  cannot be confirmed).

## 5. Apply

Apply only what the user accepted, passing each acknowledgement the preview listed and the user
accepted — never one it did not list:

```console
pidgen ticket act EXAMPLE-4 replay_from_node --node deliver --run WFR-EXAMPLE-4 --apply --acknowledge completed_source --reason "The deliver step reported nothing merged." --note "Replayed after the forge credential was renewed." --format json
```

`pidgen ticket replay EXAMPLE-4 --node deliver --format json` takes the same decision through the shared preview
and apply flags.

Exit codes: 6 `ACKNOWLEDGEMENT_REQUIRED` lists the `missing` codes; 6 `PREVIEW_STALE` means the
run or ticket changed since the preview — often it repaired itself, so preview again and re-read
it; 5 is a refusal such as `ACTIVE_ATTEMPT_EXISTS`, `RUN_NOT_TERMINAL` or `NODE_NOT_TERMINAL`; 3
means you may not take it. Repeating the same apply is safe: the CLI derives the same idempotency
key, so the server answers the first execution.

## 6. Follow it

`data.result` is the server's execute result: `command_id`, `ticket_id`, `status` (`applied`, or
`applying` while it settles — the CLI follows `status_url` until it settles unless `--no-wait`),
`disposition_code`, `workflow_run_id` and `status_url`. Then watch the run:

```console
pidgen run show WFR-EXAMPLE-4 --format json
pidgen ticket show EXAMPLE-4 --format json
```

Evidence verification, review and delivery happen normally after a replay; a replay is not a
shortcut past any of them. A replay that does not deliver leaves the ticket at `awaiting_review`.
Nothing executes without a connected worker that serves the step; check with `pidgen worker status --format json`.

## Rules

- Replay only through `pidgen ticket act --format json` or `pidgen ticket replay --format json`. Never change a ticket's stage by
  any other means.
- Diagnose first, and replay the node that produced the wrong result.
- One recovery per ticket at a time; a second is refused while the first is active.
- Never pass an acknowledgement the preview did not list, or one the user has not accepted.
- If the CLI cannot do what is needed, stop and report it; do not work around it.
