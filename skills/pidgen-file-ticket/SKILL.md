---
name: pidgen-file-ticket
description: Create work in the running Pidgen app — submit a prose intent and answer its clarification questions, or file one structured ticket as a ticket manifest with no children, previewed and committed only on the person's confirmation. Use when asked to file, submit, or create a ticket or intent. Always create work under a project. When someone outside the team asked for the work, it is not yet judged worth doing, or its target is unclear, file a request with pidgen request submit instead; pidgen-triage-requests works the request queue. To file several related tickets — ones that consume each other's changes, edit the same files, or number more than about five (a program or multi-slice plan), especially into an auto-merge project or epic — use pidgen-decompose-plan instead, which files each parent/child delivery cohort as one manifest.
---

Use `--format json` for structured CLI responses, including when stdout is a terminal.

# Create an intent or a ticket

Use the configured Pidgen profile and Account. Create work only when the user has asked for it;
an investigation or implementation request does not itself authorize filing extra tickets.
Never create throwaway work to test a server. Read the single JSON envelope (`ok`, `data`,
`error`, `meta`) and the exit code from every command.

## Choose the delivery boundary

Use an intent when the user described work in prose and wants refinement. Use a ticket manifest
for one structured ticket with a stated outcome and acceptance criteria. Both create root tickets.
Every ticket must name a Project.

Use `pidgen-decompose-plan` for related slices when a later slice consumes earlier changes, slices edit
shared files, or the batch has more than about five related tickets. Those slices should share a
parent workspace and delivery. Independent roots can be grouped in an Epic with `pidgen-manage-epics`.
Before filing several roots, inspect the Project and any Epic's merge policy with
`pidgen project show --format json` and `pidgen ticket show <epic> --kind epic --format json`; `pidgen ticket show --format json` reports the
effective policy on an existing Ticket. An auto merge policy makes sound delivery boundaries particularly important.

## File a request rather than a ticket

A ticket is work the team has decided to do, in a Project. File a **request** instead when any of
these holds:

- someone outside the team asked for it: a user, a customer, another team, or a bug report
  gathered from them;
- it has not yet been judged worth doing: nobody has decided it is work to take on;
- its target is unclear: you cannot name the Project it belongs to.

A request keeps the requester's own words and waits in the queue until someone triages it with
the `pidgen-triage-requests` skill: they acknowledge it, ask the requester a question, accept it, close
it, or promote it to a ticket in a Project. Do not file a ticket and a request for the same work.

For a bug, give the steps, the expected result and the actual result, and attach the evidence
(logs, screenshots) as files:

```console
pidgen request submit --kind bug --title "Export drops the last row" --body "Exporting a list of 50 items gives a file with 49." --steps "Open a list of 50 items, then choose Export." --expected "A file with 50 rows." --actual "A file with 49 rows." --target project:EXAMPLE --evidence export.csv --evidence screenshot.png --format json
```

For a feature, task or question, give `--kind`, `--title` and `--body`; a longer text can be a
file (`-f request.md`). `--target project:<id>` or `domain:<id>` aims it when you know where it
belongs; leave it out when the target is unclear and triage settles it. When the same problem is
reported again and again (an automated report), give the same `--fingerprint` each time so it is
counted as an occurrence of the open request rather than filed anew. Leave `--submission-key` to
the CLI: a retry of the same command is then the same submission.

Read `data.outcome`: `created` is a new request; `appended` added it to a request already
open; `occurrence` counted it on the open request with that fingerprint; `regression` matched a
resolved request with that fingerprint. Report `data.url`, the request's page, and `data.request.id`,
its key (`REQ-{n}`), to the person. `data.attachments` lists each uploaded file. A refused upload
(`FILE_TOO_LARGE`, `REQUEST_ATTACHMENT_TYPE_REFUSED`, `REQUEST_ATTACHMENTS_LIMIT`) leaves the
request filed: its `error.details` name it and the files already uploaded, so do not submit again.
`REQUEST_SOURCE_PAUSED` means nothing was filed and the source this credential submits through is
paused; `REQUEST_RATE_LIMITED` means wait and submit again. Both exit 5.

## Resolve the Project and workflow

```console
pidgen project list --format json
pidgen project show EXAMPLE --format json
pidgen ticket list --kind epic --project EXAMPLE --format json
pidgen ticket types --format json
```

Read Project IDs or ticket-key prefixes from `data`; use the user's intended Project explicitly.
Use a registered workflow type key from `pidgen ticket types --format json`, such as `implementation`.
An Epic is optional: a ticket of kind `epic` in the same Project, by key (such as `EXAMPLE-40`)
or id. The ticket's `parent_ticket_id` names it once filed. Use `pidgen-manage-epics` to create one.
If the Project is missing, report the missing Project rather than inventing an unsupported command.

## Keep the whole completion contract free of human prerequisites

Keep acceptance criteria, the objective, scope, assumptions, referenced plans, context and rework
instructions machine-verifiable. "Owner accepts the baseline before evaluation" blocks an
implementer even when every acceptance criterion passes. Moving that requirement outside the criteria does not remove
the gate. Never require a human review, sign-off or approval artifact to finish ticket work.

Separate evidence production from later product decisions. For an optional experiment, collect
the baseline and comparison automatically, define observable evidence requirements, and retain
the current default. A person may review the delivered evidence or decide adoption afterwards;
neither is a prerequisite for execution, verification, completion or downstream work. Explicit
workflow approval and merge policies remain separate; do not change them implicitly.

Define what makes evaluation evidence sufficient: equivalent scenarios and revisions, actual
exposure to the feature under evaluation, retained metrics and honest outcomes. A mode label
alone does not prove the feature ran. Failed or capped exploration may be valid measured evidence
when the agreed scope permits it; do not silently require a favorable result or claim success
from incomplete outcomes. Name any required goal completion explicitly as observable behaviour.

Before filing, check every completion instruction for human prerequisites. If removing one
would change the user's requested scope, settle that scope before execution. Do not invent an
approval or remove a required automated check to make the ticket pass.

## Submit prose work

Write an intent file, for example `intent.yaml`:

```yaml
title: Add pagination to the ticket list
objective: Return bounded pages and a total count, with tests for page boundaries.
project_id: EXAMPLE
target_lane: backlog
```

```console
pidgen intent submit -f intent.yaml --format json
```

Intent submission sends immediately; it has no preview/apply flags. Choose optional `epic_id` (the
Epic's ticket key, which becomes the created ticket's `parent_ticket_id`), `approval_mode`,
`merge_policy`, `team_member_id` and `target_lane` only within the user's request.
A ready-for-implementation target lane commits work to execution after refinement and requires an
explicit Agent selection. Do not choose it just to speed up filing.

Switch on `data.outcome`:

- `created`: retain `ticket_id`, `ticket_key`, `stage`, `ticket_url` and any `command_error`.
- `needs_clarification`: retain `conversation_id`, the request's key (`REQ-{n}`), and bring
  `questions` back to the user.
  Use their words; never invent answers. Answer the questions by their 0-based indexes:

```yaml
answers:
  - question_index: 0
    answer: Email and password.
delegate: false
```

```console
pidgen intent respond REQ-12 -f answers.yaml --format json
```

`still_needs_clarification` means more answers are needed. Use `delegate: true` only if the user
has authorized creating from the information already supplied. If the conversation expires,
submit the intent with the user's answers folded into its objective.

## Create one structured ticket

A structured ticket is filed as a ticket manifest with no children: the ticket is the manifest's
`root`. Write the annotated template without children and fill it in:

```console
pidgen manifest template --children 0 -o ticket-manifest.yaml --format json
```

Replace the placeholders with the user's work. A minimal example:

```yaml
schema_version: pidgen.ticket-manifest.v1
project_id: EXAMPLE
epic_id: null
promote: false
root:
  ref: root
  title: Add pagination to the ticket list
  objective: Return bounded pages and a total count, with tests for page boundaries.
  workflow_type: implementation
  estimated_complexity: 3
  team_member_id: AGENT-EXAMPLE
  scope_boundaries: 'In: the list command and its tests. Out: other commands.'
  acceptance_criteria:
    - statement: A page beyond the end returns an empty list.
      priority: MUST
      assertion: The result has no items and retains the total count.
children: []
edges: []
```

`epic_id` names the Epic to file the ticket in, by its ticket key or id, or `null` for none; it
becomes the ticket's `parent_ticket_id`. It is the only name the manifest takes for it.

`pidgen manifest apply -f ticket-manifest.yaml --format json` previews the manifest and changes nothing. The CLI
first checks the file against the manifest schema: an invalid file exits 2 with `INPUT_INVALID`
and sends nothing. Read `data.committable`, `data.promotable`, `data.preview_digest`, `data.findings`
(grouped by ref: `manifest`, then `root`) and the server's resolved `plan`. Show the person every
finding and the plan: the ticket's title, workflow type, selected Agent and readiness. Fix every
finding the preview reports, then preview again. A preview that is not committable exits 5 with
`MANIFEST_NOT_COMMITTABLE`, and no commit is sent; its `error.details` carries the same report.

Commit only after the person confirms the preview:

```console
pidgen manifest apply -f ticket-manifest.yaml --apply --format json
pidgen ticket show EXAMPLE-12 --format json
```

The commit previews the same file again and sends the preview's digest with an idempotency key, so
repeating it is safe. Keep the ticket key that `data.tickets` gives for `root`. A manifest changed
since the preview is `PREVIEW_STALE` (exit 6): preview again rather than retrying the commit.
Nothing exists on the server until the commit, and the commit writes everything or nothing.

`promote: true` promotes the ticket for execution in the same commit; every promotion gate must
then pass. Set `promote: true` only when the person asked for the work to run, and leave it
`false` otherwise: filing work is not a request to execute it. A ticket runs only with 60 of 100
readiness points and an `estimated_complexity`; each field's comment in the template says the
points it earns. Never add `--ack` codes on the person's behalf.

The server must publish the manifest routes. Until it does, report that refusal and its
`error.code` to the person.

To file children with the ticket, use `pidgen-decompose-plan`: a cohort is one manifest with its root,
children and edges.

`team_member_id` is an **Account Agent ID, not a model name**, a non-empty string of at most
80 characters. Omitted, the root uses the Project default, else the Account's reserved Unassigned
Agent. Select that reserved ID explicitly when you want Unassigned; null is refused.
The CLI forwards IDs unchanged and leaves omitted fields absent.
The Agent is chosen when the ticket is created and can be reassigned later with an edit file
naming `team_member_id`. Pick the initial Agent before committing the manifest.

## Edit an existing Ticket

Fix the existing Ticket rather than filing a replacement. If a hand-refined Backlog Ticket is
short of the readiness threshold for promotion, edit `success_metrics`, `context_artifacts` and
`required_capabilities` as needed, then check readiness again with `pidgen ticket show --format json`.
An edit file contains only changes:

```yaml
priority: 2
scope_boundaries: 'In: the list command, its tests and its docs. Out: other commands.'
success_metrics:
  - name: List command check
    target: passes
context_artifacts:
  - type: code_reference
    content: 'Extend the list command tests with success, refusal and usage checks.'
required_capabilities:
  - typescript
```

```console
pidgen ticket edit EXAMPLE-12 -f edit.yaml --format json
```

These fields are optional whole-list replacements, with the same item shapes as creation:
metrics require `name` and `target`, with optional `current` and `unit`; context artifacts require
`type` and `content`, with optional `reference_url` and `tier`; capabilities are strings.
Arrays (including empty lists) and null are accepted. Omitted fields stay unchanged.

The CLI GETs the Ticket, then sends PATCH with that fetched version. Never put `version` in an
edit file: manual versions are invalid. `team_member_id` reassigns the Ticket to the named
Account Agent; null, an empty ID or an ID over 80 characters is invalid locally.
`data.version` is the updated server version;
`data.admission` describes any admission effects. A version conflict exits 5 without automatic
write retry or admin fallback. Read the Ticket again and decide whether the edit remains
appropriate.

Assignment eligibility and active-run effects belong to the server. Let it decide authorization,
same-Account membership and archived-Agent eligibility at creation or reassignment, and do not
substitute another Agent after a refusal.

## Write verifiable criteria and check the result

A criterion needs only a non-empty `statement` describing observable behavior. `assertion` is
optional prose about what a verifier sees. Add `test_assertion` only for one specific pinned
runnable check; leave it out otherwise. Prefer existing test files, and do not replace a precise
check with a broad suite merely to get a passing result. Do not demote an unobservable criterion
to SHOULD to hide it. `success_metrics` are objects with `name` and `target`. A metric names the ticket's own checks; never the full suite ("make test: green", "full test suite: green").

For criterion edits, use stored `id` values to retain matching evidence. Omit `assertion` to
preserve it or use null to clear it; `status` and `evidence` are server-owned.

Inspect the Ticket with `pidgen ticket show --format json`. If refinement is parked, inspect `pidgen run list --format json`
and `pidgen run show --format json`, or use the recovery skills; do not file a duplicate. Report the returned
Ticket reference and outcome to the user.

Server errors retain `error.code`, `error.message` and `error.details`. Invalid local inputs exit
2 before requests; insufficient authorization exits 3; an unknown Project (`PROJECT_NOT_FOUND`) or
an unknown or foreign Agent reported as 404 exits 4; a manifest that is not committable, an
assignment or version refusal reported as 409, and other refusals exit 5; a stale preview exits
6. Treat archived-Agent refusals according to the returned status. Never use an admin endpoint as a fallback.

A criterion is proved from the ticket's own workspace. Never write one that needs a running
system, another Project's real implementation or a real model provider, and never file a ticket
whose job is integration or end-to-end testing; list those checks in the plan's test plan for
your QA process.

When another Project must change, name the provider ticket that delivers the change and carry the
provider's interface into the consumer ticket one of three ways; a contract is never required:
attach the spec file (an OpenAPI document, a GraphQL schema, a proto file) to the ticket, as a
`context_artifacts` item with its text in `content` or a `reference_url` to it, state the interface in its scope (the operations, fields and errors it relies
on), or link a contract, reusing one from `pidgen contract list --format json` or creating one with the
`pidgen-manage-contracts` skill when the interface is shared or will change. File provider work only within
the user's authorization. Build consumer checks against a
committed schema, fixture or stub so they pass from this Project alone. An objective or assumption
mentioning another Project's change does not gate dispatch; cross-Project dependency edges are
refused. If the interface is undecided, leave the consumer unpromoted until it is settled.

For external QA checks, list environment prerequisites and preflight checks in the plan: the
target release, Account and worker availability where required, credentials, dependent services
and rate limits. Check claims against public documentation, contracts or authorized QA evidence.
Keep missing infrastructure out of ticket completion; correct the plan instead of retrying the
same unmet prerequisite. See `pidgen-decompose-plan`, "Work that spans Projects" and "Check claims and
name environment prerequisites".
