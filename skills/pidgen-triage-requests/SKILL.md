---
name: pidgen-triage-requests
description: Work the Pidgen request queue — list new requests, read each one with its timeline, acknowledge it or ask the requester a question, accept it (with a bug's details or the missing ones named unknown), close it with a reason, or promote it to a ticket in a Project, with pidgen request list, show, reply, acknowledge, accept, close and promote. Use when asked to triage, review or work through requests or bug reports. To file a new request or ticket, use pidgen-file-ticket instead.
---

Use `--format json` for structured CLI responses, including when stdout is a terminal.

# Triage requests

A request is work someone asked for: a `bug`, `feature`, `task` or `question`, in the requester's
own words. Triage decides what happens to it. Use the configured Pidgen profile and Account; every
write here needs the `request.triage` permission. Read the single JSON envelope (`ok`, `data`,
`error`, `meta`) and the exit code from every command.

Triage acts directly: no request command has a preview, `--apply` or `--ack`. Each write reads the
request's current `version` and sends it, so act on what you just read, and tell the requester
only what the person triaging has decided. Never invent an answer, a priority or a Project.

## 1. List the new requests

```console
pidgen request list --state new --format json
```

`data` is the list of requests, newest first. Narrow it with `--kind bug`, `--target
project:EXAMPLE` (or `domain:<id>`), `--source <id>` or `--query "export"`; `--page` and
`--per-page` read one page. Also list `--state acknowledged` for requests already seen: one that
was asked a question and no longer has `waiting_on_requester` set has its answer in the timeline.

## 2. Read one request

```console
pidgen request show conv-EXAMPLE --format json
```

`data.request` carries `state`, `kind`, `title`, `body` (the requester's text, never rewritten),
`details` (a bug's `steps`, `expected`, `actual` and the `unknown` ones), `urgency`, `priority`,
`target`, `source`, `requester`, `occurrence_count`, `waiting_on_requester` and `version`.
`requester` is null when no one is named, and `requester.contact` appears only when you may see it.
`data.timeline` lists the entries oldest first (`requester`, `reply`, `note`, `system`,
`occurrence`), each with its `author` and its `files` (each file's name, media type and size). Read the
whole timeline before deciding: an answer to an earlier question is there.

`REQUEST_NOT_FOUND` (exit 4) means no such request in this Account, or one you may not see.

## 3. Acknowledge it, or ask the requester

When the request is understood but not yet decided, acknowledge it so the requester knows it was
seen:

```console
pidgen request acknowledge conv-EXAMPLE --format json
```

When something is missing (a bug without its steps, a feature with no outcome), ask:

```console
pidgen request reply conv-EXAMPLE --text "Which browser were you using when the export lost a row?" --ask --format json
```

The request then waits on the requester (`data.request.waiting_on_requester` is true); come back
to it when they answer. `pidgen request reply conv-EXAMPLE --text "..." --format json` without `--ask` sends a
reply that asks nothing. `REQUEST_REPLIES_OFF` (exit 5) means the request's source does not carry
replies to the requester: you cannot ask through Pidgen, so decide with what the request already
holds, accepting a bug's missing details as unknown (step 4) or closing it (step 5).

## 4. Accept it

Accept a request the team will do, with a priority when the person gave one:

```console
pidgen request accept conv-EXAMPLE --priority P2 --format json
```

A bug is accepted only with its steps, expected and actual results. When the requester cannot give
one and the bug is still worth doing, name the missing ones as unknown:

```console
pidgen request accept conv-EXAMPLE --priority P3 --unknown steps --format json
```

`REQUEST_BUG_DETAILS_REQUIRED` (exit 5) means a detail is missing and not named unknown: ask the
requester (step 3), or accept again with `--unknown` for the ones nobody can give.

## 5. Or close it with a reason

Close a request that will not be done. `--reason` is required, one of `cannot_reproduce`,
`wont_do`, `duplicate`, `invalid`, `answered`, `no_response`, `withdrawn` and `other`; a
`duplicate` names the request it duplicates, and `other` carries a note:

```console
pidgen request close conv-EXAMPLE --reason duplicate --duplicate-of conv-EXAMPLE2 --format json
pidgen request close conv-EXAMPLE --reason other --note "Covered by the export rewrite already planned." --format json
```

Find the original with `pidgen request list --query "<words from the title>" --format json` before closing as a
duplicate. Another reason, or a missing `--duplicate-of` or `--note`, is refused before anything is
sent (`CLI_USAGE`, exit 2).

## 6. Promote it to a ticket

Promote an accepted request when the team is ready to plan it. The ticket goes to the Project the
request targets; `--project` confirms it:

```console
pidgen request promote conv-EXAMPLE --format json
pidgen request promote conv-EXAMPLE --project EXAMPLE --format json
pidgen request promote conv-EXAMPLE --project EXAMPLE --workflow-type implementation --no-refine --format json
```

Promotion carries every attachment to the ticket and starts refinement unless `--no-refine`.
`data.ticket_id` is the new ticket; read it with `pidgen ticket show --format json`. A retry answers the same
ticket, so repeating a promote after a network failure is safe. Use `pidgen project list --format json` to find
the Project and `pidgen ticket types --format json` for a workflow type. `REQUEST_TARGET_NEEDS_PROJECT` (exit 5)
means the request targets a Domain or nothing, or not the `--project` given: it must target a
Project before it is promoted, so ask the person where it belongs. A `403` means you may not create
work in that Project.

## After every write

`data.state` is the request's new state (`acknowledged`, `accepted`, `promoted`, `closed`), and
`data.request` the request itself. Report it to the person.

- `REQUEST_VERSION_CONFLICT` (exit 5): the request changed since it was read. Show it again, check
  that the decision still holds, and repeat the command.
- `REQUEST_TRANSITION_REFUSED` (exit 5): its state does not allow that write; a promoted request
  no longer changes. Show it and report its state.

Move to the next request in the list until the queue is worked or the person stops.
