# Preview and apply

Commands with side effects that the App Service can preview — `ticket act`, `ticket retry`,
`ticket replay`, `ticket reopen`, `ticket cancel`, `plan apply`, `plan promote` — share one flow. It exists so that an
agent cannot apply a change it has not seen.

`pidgen auth login` is not one of them: it changes only the local configuration, has nothing on the
server to preview, and instead verifies the credential with the server before writing it
([Commands](commands.md#auth-login)). Nor are `pidgen auth status`, `pidgen auth list` and `pidgen account list`: they only read
(`GET /me` or `GET /me/sessions` with a CLI token) and change nothing. `pidgen auth revoke <id>`
revokes a session or CLI token at once: `DELETE /me/sessions/{session_id}` has no preview route, so,
like `pidgen ticket dep rm`, it acts directly on the one id you name
([Commands](commands.md#auth-revoke)).
`pidgen worker subscriptions use` has no preview route either: it acts directly, guarded instead by
the `expected_primary` it takes from a fresh read, which the worker refuses with
`SUBSCRIPTION_STALE` when its primary has changed ([Commands](commands.md#worker-subscriptions)).
The domain writes (`pidgen domain create`, `edit`, `archive`, `unarchive`, `project add|rm`,
`parent add|rm`, `member add|rm` and `maintainer add|rm`) have no preview route either: each acts
directly on the domain you name, and the server refuses a change that would break the domain graph
or strand open work with its own code ([Commands](commands.md#domain)).
`pidgen contract revise` and `pidgen contract accept` have no preview route either: each acts
directly on the contract you name. A revision is validated before it is sent, and whether it waits
for a person is the Account's Contract approval setting, not a preview ([Commands](commands.md#contract)).
`pidgen ticket contract implements`, `builds-against` and `rm` act directly too: the server
refuses a link it does not allow with its own code and writes nothing
([Commands](commands.md#ticket-contract)).
The `pidgen request` writes (`submit`, `reply`, `acknowledge`, `accept`, `close` and `promote`)
have no preview route either: each acts directly, and each triage write sends the version it just
read, so a Request changed in between is refused with `REQUEST_VERSION_CONFLICT`
([Commands](commands.md#request)).

Ticket creation and intent submission also act directly: `pidgen ticket create` creates a ticket
from your input, and `pidgen intent submit` submits work that may become a ticket or clarification
questions. Review the input before running either command. Local installation and worker lifecycle
commands change the machine as described in [Skills](skills.md) and [Workers](workers.md).

## The flow

```console
$ pidgen ticket retry PIDGEN-4 --format json
{"ok":true,"data":{"preview_digest":"sha256:9f…","required_acknowledgements":[],"action":"retry_run","target":{…},"consequence":{…},…},…}

$ pidgen ticket retry PIDGEN-4 --apply --digest sha256:9f… --format json
{"ok":true,"data":{"settled":true,"result":{"status":"applied","action":"retry_run","target":{…},"result":{…}},"idempotency_key":"pidgen-…"},…}
```

1. **Without flags the command only previews.** It prints the plan, its `preview_digest`, and any
   `required_acknowledgements`. Nothing changes.
2. **`--apply --digest <d>` applies exactly that plan.** If the plan has changed since the preview,
   the server refuses with `PREVIEW_STALE` (exit 6); preview again. The error's `details.next`
   says so.
3. **`--apply` without `--digest`** is allowed only when a fresh preview requires no
   acknowledgements. The CLI previews, then applies that preview's digest. Otherwise it exits 6
   with `DIGEST_REQUIRED` and prints the preview. `pidgen ticket act` differs: it previews and
   executes that preview's digest when every acknowledgement the preview requires was passed with
   `--acknowledge` (or `--ack`), and otherwise exits 6 with `ACKNOWLEDGEMENT_REQUIRED`, the missing
   codes and the preview, executing nothing.
4. **Acknowledgements are explicit.** Pass each code the preview listed:
   `--ack ambiguous-effects --ack completed-source`. The CLI never adds one on its own. A missing
   code is refused with `ACKNOWLEDGEMENT_REQUIRED` (exit 6); `details.missing` lists the codes and
   `details.next` names the `--ack` flags that would accept them.
5. **Any other refusal exits 5** with the server's code, message and details, for example
   `PLAN_ALREADY_ADMITTED` or `COMMAND_IDEMPOTENCY_CONFLICT`. A refusal reported by the status
   route while waiting, or answered with `200`, is treated the same way.
6. **`--reason <text>`** is recorded in the audit log. It is required when the preview says so.

Commands use the shared preview/apply option set: `--apply`, `--digest <d>`, repeatable
`--ack <code>`, `--reason <text>`, `--idempotency-key <key>`, and `--wait` / `--no-wait`.

## Human-readable mutation results

On a terminal, previews begin with **Preview — not applied.** They show the proposed effects,
consequences, warnings, blockers and findings, followed by the supplied digest and acknowledgement
requirements. A manifest preview shows its committable and promotable state and findings by ref;
a promotion preview shows every gate and repair target. Repair blockers and preview again before
applying.

The application instructions contain complete, copyable flag values. For example, a retry preview
with digest `sha256:preview-1` and required code `completed_source` ends with:

```text
To apply, review the preview and rerun with the same arguments and input, adding:
  --apply --digest sha256:preview-1 --ack completed_source
```

Review those requirements before choosing to pass them. Printing the instructions does not apply
the change, add acknowledgements, or ask a question. Keep the original target, action, input file,
and other arguments when rerunning. A contract `--check` result is also an unapplied preview; its
instructions say to review it before rerunning without `--check`. Raw API previews retain their
requirements and refer to the matching public apply route and request body; `api post` does not
gain `--apply` flags.

Successful applications with `settled: true` begin with **Applied — settled.** Accepted operations
with `settled: false` begin with **Accepted — still pending.** A cancellation in `accepted` or
`halting` state also remains pending even though its apply request has settled. Queued or dispatched
session instructions remain pending. Direct writes show **Response received.** with their supplied
state, resource keys and details; this heading does not claim that later execution has finished.
Intent responses that still need answers say **Needs clarification.** Local template writes say
**Template created.** and show the file path.

Pending results retain their operation handle, status URL and supplied follow-up instructions.
A timed-out wait exits 8 and says **Wait timed out — still pending.** with the handle and last known
result; the operation was not cancelled. Refusals retain their codes, findings, missing
acknowledgements, recovery guidance and any preview. Manifest applications show each created ticket
key and the supplied `promoted` state. Human output uses labeled sections at narrow widths and
keeps actionable values and commands intact, even when they are wider than the terminal.

Use `--format json` for automation and the complete JSON envelope. Human rendering changes no
requests, polling, exit codes, prompts, acknowledgements or progress on stderr.

## Idempotency

Every apply sends an idempotency key. By default the CLI derives it from the command, the target,
and the digest, so running the same apply twice — after a network failure, say — returns the first
result instead of acting twice. `--idempotency-key <key>` sets it explicitly.

## Waiting

- `--wait` (the default with `--apply`) polls the operation's status route until it settles, then
  prints the settled result. `--timeout` bounds it; a timeout exits 8 and the operation keeps going
  on the server.
- `--no-wait` returns as soon as the server accepts the apply, with its result so far (`status`
  `applying` and its `status_url`) and the status route as `handle`, to check later.
- While polling, progress is written to standard error only when standard error is a terminal.
  Nonterminal stdout defaults to the final JSON envelope; terminal stdout defaults to human output.
  `--format json` or `--format table` overrides this independently of stderr.

## Server convention

Every public preview/apply pair uses the same fields, and the CLI drives them all the same way:

- **Preview:** the preview route (for example `POST /tickets/{ticket_id}/reopen/preview`) answers
  `preview_digest` and `required_acknowledgements` beside the plan. A preview without them is an
  unexpected response (exit 1). Previewing writes nothing.
- **Apply:** the apply route receives `preview_digest`, `idempotency_key`, `acknowledgements` (only
  the codes given with `--ack`) and, with `--reason`, `reason`, beside any route-specific fields
  such as the `plan` a child-plan replacement sends back, or the `retain_workspace` and
  `disposition` (`cancelled`, `wont_do` or `superseded`, with `superseded_by`) a ticket cancellation
  sends (`POST /tickets/{ticket_id}/cancellation/preview`, then `POST /tickets/{ticket_id}/cancellation`,
  with the previewed `retain_workspace` and `close_pull_request`).
- **Settling:** `200` means settled. `202`, or a result whose `status` is `applying`, means the
  apply is still settling; its `status_url` is polled with `GET` until it answers `200`. The status
  route is always read from the configured server: an absolute `status_url` contributes only its
  path, so the credential never goes to another origin.
- **Refusals** come back as errors with their code: `PREVIEW_STALE` and `ACKNOWLEDGEMENT_REQUIRED`
  exit 6 with `details.next` naming what to do; every other refusal exits 5.
- **A refusal answered with `200`** is still a refusal. A preview, apply or status result whose
  `status` is `refused` (or `rejected`), whose `disposition` is `refused`, or that names a
  `disposition_code` without being `applied` or `applying` applied nothing: its `disposition_code`
  becomes `error.code` and it exits 5 (6 for `PREVIEW_STALE` and `ACKNOWLEDGEMENT_REQUIRED`), with
  `details` carrying the HTTP `status`, `disposition_code`, any `disposition_detail`, and the
  server's `result`. A script therefore never reads a refused plan as a success.

The Ticket actions pair follows the same convention: `POST /tickets/{ticket_id}/actions/preview`
takes `{action, target}` and answers the preview, and `POST /tickets/{ticket_id}/actions/execute`
takes the same `action` and `target` beside `preview_digest`, `idempotency_key`,
`acknowledgements` and `reason`, answering `200` when settled or `202` with `status_url`. A
refusal is an error carrying the refusal's code ([Commands](commands.md#ticket-actions-and-act)).

Ticket cancellation's apply always answers `200`; its result's `state` (`accepted`, `halting`,
`converged`) reports how far the cancellation has converged, and repeating the apply answers the
same cancellation. Its preview's `required_acknowledgements` may list `cancels_descendants` and
`discards_workspace`. `pidgen ticket cancel` sends `retain_workspace: false` to both routes with
`--discard-workspace`, `close_pull_request: true` to both with `--close-pr` (without it,
`close_pull_request: false`, and an open pull request is left open), and `disposition` and
`superseded_by` from `--disposition` and `--superseded-by` ([Commands](commands.md#ticket-cancel)).
The preview digest covers `close_pull_request`, so an apply with the other choice is `PREVIEW_STALE`.

## For skill authors

A skill must preview, show or reason about the plan, and then apply with the digest it received.
It must never pass `--ack` unless the preview listed that code and the skill's instructions say when
accepting it is right.
