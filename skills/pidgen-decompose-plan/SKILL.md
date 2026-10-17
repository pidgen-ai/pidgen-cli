---
name: pidgen-decompose-plan
description: Turn already-specified work into merge-safe parent/child delivery cohorts in the running Pidgen app — decide whether related tickets are independent roots or must share one parent workspace because later work consumes unmerged changes or edits the same files, cluster a program-sized batch of slices into cohorts ordered root to root, slice the children vertically (tracer bullets, or expand–contract for a wide refactor), then file each cohort — its root, children with their starting briefs, and the edges among them — as one ticket manifest, previewed and committed only on the person's confirmation. Use when asked to decompose, split, or break work into child tickets, to file more than a handful of related tickets (a program or multi-slice plan, especially into an auto-merge project or epic), to hand-author a cohort, to regroup already-filed roots whose PRs conflict, or to repair or replace an existing child plan. For work that spans projects, files one cohort per project under one Domain Epic and links each cohort's root to the contract it implements or builds against.
---

Use `--format json` for structured CLI responses, including when stdout is a terminal.

# Decompose work into a delivery cohort

A delivery cohort has one high-level root plus child Tickets that share its workspace and
ship together. This skill turns already-specified, authorized work into cohorts and files each new
cohort as one ticket manifest: its root, children and edges, committed together.
Use the configured profile and Account; read JSON envelopes and exit codes from every command.

## Choose cohorts before filing

Create work only when the user has requested it. A reviewed plan the user asked you to file is
authorization; a plan written during an investigation is not. Explain the proposed grouping and
resolve any missing scope before creation.

Use one parent when either of these holds:

- A later slice consumes code, schemas, tests or other artifacts an earlier slice produces.
- Slices edit the same existing files and their separate deliveries would conflict.

Independent roots are appropriate when they can execute from the current Project base and
have no overlapping writes with other unordered roots. An Epic (a ticket of kind `epic` that its
members name as their `parent_ticket_id`) groups records but does not provide a shared workspace. Order cohorts with root-to-root blocking edges using
`pidgen ticket dep add --format json`, since a manifest has one root (see "Order and promote cohorts"); do not put
a dependency between a child and another cohort. Dependency edges cannot cross Projects; split
cross-Project work along a contract (see "Work that spans Projects"). Record any remaining
release or QA sequencing as a manual step outside ticket completion.
Do not treat a feature flag as a way to make unmerged prerequisite code available.

Never file a ticket whose job is integration or end-to-end testing: checking a slice against a
running system, another Project's real implementation, or a real model provider. Build each
slice against the published contract with fixtures, and list those checks in the plan's test
plan, where your QA process runs them outside the ticket workflow.

For more than about five related slices, first predict existing-file write sets and consumption
relationships. Cluster overlapping or consuming slices, split large clusters along dependency
chains, and account for shared hotspot files. Avoid many concurrently runnable roots editing the
same hotspot. Use `pidgen plan cohorts -f slices.yaml --format json` to check or propose grouping locally:

```yaml
slices:
  - id: first
    files: [src/feature.ts]
    needs: []
  - id: second
    files: [src/feature.ts]
    needs: [first]
```

Use the documented cohorts input format for optional `hotspots` and `cohort` choices. Review its
proposed cohorts, root edges, cycles, longest chain and ready cohorts. Record a table of chosen
cohorts, children, shared files and blocked-by cohorts in the user's plan. Include contracts needed
from other Projects, their provider tickets and any external QA or release sequencing. Inspect
merge policies with `pidgen project show --format json` and `pidgen ticket show <epic> --kind epic --format json` before filing into auto merge workflows.

### Work that spans Projects

A ticket's workspace contains its own Project's base. It cannot deliver another Project's
change, and Pidgen refuses cross-Project dependency edges with `DEPENDENCY_CROSS_PROJECT`.
A prerequisite mentioned only in an objective, assumption or plan does not enforce ordering.
A passing promotion preview does not prove another Project's implementation is available.

Split the work along the interface the consumer needs:

1. **Name the contract.** Name the response field, message schema, command output or protocol
   version the consumer relies on. Cross-Project work carries the provider's interface one of three
   ways, and a contract is never required:
   - **attach the spec file** (an OpenAPI document, a GraphQL schema, a proto file) to the consumer
     ticket: its text or a `reference_url` to it in the ticket's `context_artifacts` (a child's
     brief), or the file committed as a fixture in the consumer's own workspace;
   - **state the interface in its scope**: the operations, fields and errors the consumer relies
     on, in the consumer ticket's scope;
   - **link a contract**: reuse one the server holds, or create one with the `pidgen-manage-contracts`
     skill when the interface is shared by several pieces of work or will change.

   Look for a contract first. `pidgen contract list --project ALPHA --format json` lists a project's contracts
   and those its work builds against; `pidgen contract list --domain EXAMPLE --format json` lists a domain's and
   its projects' contracts. `pidgen contract show CT-7 --format json` reads one: its `status`, its `revisions`
   with their `operations` and how each was accepted, and the work already implementing it or
   building against it. When none fits and none is worth creating, attach the spec file or state
   the interface in scope, and file the work as planned.
2. **Give the provider change an owner.** File the change in the provider's Project, with local
   criteria proving that it publishes the agreed contract. File only within the user's authorized
   scope; if that Project's work is not authorized, report the missing provider work and resolve
   the scope before filing it. Do not assume a consumer ticket asks the provider to change.
3. **Build the consumer against the contract.** Build against fixtures of the contract in the
   consumer's own workspace: the contract's accepted revision reaches a linked ticket's runs
   automatically, and the consumer may commit the fragment it needs. Use fixtures, a stub or a
   fake provider so every criterion can pass from the consumer's own workspace. No criterion
   should require the real provider to change, be deployed or be available. A root that builds
   against a pending operation, one `pidgen contract show --format json` lists as `pending` because it is
   proposed and not yet in the provider's published spec, builds against a mock of it in its own
   workspace, and none of its criteria waits for the operation to land; a `landed` operation is
   the real interface.
4. **Put live integration in the external QA plan.** Record which provider delivery and release
   the check needs, and run it through the QA process after those prerequisites are met. Never
   file a separate integration-test ticket or make that check a child, a root completion gate or
   a hidden prerequisite in ticket prose. Preserve explicit approval and release policies.

#### One cohort per project, under one Domain Epic

Track the projects' work together under a Domain Epic, an Epic filed in a domain that covers
every project the work touches (`pidgen-manage-epics`, "File a Domain Epic for work across projects").
Find one with `pidgen domain epics EXAMPLE --format json`, or file it first. Then file one cohort per project,
each as its own manifest (see "File each cohort as one manifest"), each manifest's `epic_id`
naming the same Domain Epic, for example `epic_id: EXAMPLE-12`; it becomes each root's
`parent_ticket_id`. A project outside the domain's coverage is refused with
`PARENT_OUTSIDE_DOMAIN`. The Domain Epic orders nothing, and edges between the cohorts' roots
cannot cross projects.

#### Link each cohort's root to the contract

After each commit, link the cohort's root to the contract, never its children: a ticket inside a
cohort is refused with `CONTRACT_LINK_INSIDE_COHORT`. The provider's delivery root implements the
contract, and each consumer's root (or its Epic) builds against it, naming the operations it uses
with `--operation`:

```console
pidgen ticket contract implements ALPHA-40 CT-7 --format json
pidgen ticket contract builds-against BETA-12 CT-7 --operation 'GET /payments' --format json
```

Each `--operation` names one operation of the contract's newest accepted revision; none named
means all of them. `data` is the link; an implements link adds the criterion "implements CT-7" to
the provider's root and names it in `criterion_id`. A link never blocks and never orders work: it
is not a dependency edge, the consumer still builds against fixtures of the contract in its own
workspace, and the contract's accepted revision reaches the linked work's runs automatically.
Linked work waits only when the Account's Contract approval setting asks for a person to accept a
new revision; then whoever the server allows accepts it with `pidgen contract accept CT-7 --format json`. Never
turn that acceptance into a criterion or a step of any ticket.

The link refusals write nothing and exit 5 with the server's `error.code` and `error.details`:

- `CONTRACT_LINK_NOT_DELIVERY_ROOT` or `CONTRACT_LINK_INSIDE_COHORT`: link the cohort's root
  instead.
- `CONTRACT_LINK_OUTSIDE_PROVIDER`: only a root in the provider's project (or, for a domain's
  contract, a project the domain covers) implements it.
- `CONTRACT_LINK_OWN_PROVIDER`: work in the provider's own project needs no builds-against link.
- `CONTRACT_DEPRECATED`: link the replacement that `error.details` names.
- `CONTRACT_RETIRED`: leave the link out and report it; refinement links a current contract.
- `CONTRACT_UNKNOWN_OPERATION`: the newest accepted revision lacks that operation; check
  `pidgen contract show CT-7 --format json` and name only its operations, or none.

For example, if a consumer needs a new response field, the provider ticket adds the field and
tests its response schema locally. The consumer ticket handles a fixture with that field. The
QA plan checks the deployed response after the provider release; neither ticket needs the other
Project's running implementation to pass its criteria.

### Check claims and name environment prerequisites

Verify assumptions about another system against its public documentation, committed contract or
authorized QA evidence before planning around them. Record the source and revision; do not
invent behavior or depend on private service internals. Review known limitations relevant to the
interface. An unavailable or contradictory contract needs a plan correction, not another retry.

Live checks belong in the external QA plan and depend on an environment. Name the target instance
and release, Account and worker availability where required, credential requirements, model or
other service availability, forge access and rate limits. Record a preflight check that fails
when each prerequisite is missing, using public CLI capabilities where available; report missing
capabilities rather than using an internal route. Refer to credential sources without recording
secrets in the plan.

Keep an environment-dependent QA check pending until its prerequisites are available. Missing QA
infrastructure does not become ticket acceptance work. If an implementer's remaining work names
another Project's change or a missing live environment, correct the authorized scope and criteria
to use the contract before recovery; use `pidgen-retry-run` to verify corrected inputs are
adopted rather than replaying the same blocker.

Review contracts and prerequisites before promotion. The server may refuse content edits or plan
changes once execution owns the work (`EDIT_EXECUTION_ALREADY_ACCEPTED`, `PLAN_ALREADY_ADMITTED`).
Surface those refusals and use the supported recovery guidance; do not assume a replay changes
frozen inputs or an unstarted child is always editable.

### Human decisions are not cohort completion gates

Apply `pidgen-file-ticket`'s whole-completion-contract rule to each root and child, including their
objectives, scope, referenced plans and integration instructions. Machine-verifiable child
criteria do not help if the root's final turn must wait for someone to accept a baseline,
review evidence or decide adoption. No root-to-root dependency should wait for such a milestone
hidden in ticket prose.

Give evaluation work observable evidence requirements and run it automatically. Keep later
product review or adoption outside ticket completion, and specify the existing default that
downstream cohorts can use without that decision. Do not manufacture approval, waive feature
exposure or change an explicit approval/merge policy to unblock the cohort.

## Slice vertically

Each child should deliver a narrow complete behavior through the relevant layers and be
verifiable on its own. Make the first child the thinnest path proving the design. Later children
widen it. Each must fit a fresh agent context and have observable MUST criteria. Criteria need
only a `statement`; add an optional `assertion` to clarify the observation, or `test_assertion`
only for a specific pinned runnable check. Reuse the relevant existing test file where possible.
Write each child's brief while slicing (see "Attach each child's brief").

For a wide mechanical refactor, sequence expand, migrate and contract children under one parent;
order each migration after the expansion and the contraction after every migration. Give each
child its real blockers rather than ordering all work arbitrarily.

### Size the cohort: fewer, larger children

Children of one cohort run one at a time in the shared workspace, and every child pays a fixed
cost before and after its work: a fresh session that has to find its way around the repository,
then verification and delivery. Six thin children pay that cost six times. When slices edit the
same files, prefer three or four children that each still fit one fresh session over six or seven
that each change a few lines. Split further only when a child would need a tour of the whole
feature before it could start.

### Match the Agent to the difficulty

When the Account has Agents of different capability and cost, reserve the most capable one for
the slices that are genuinely hard: concurrency, recovery and state-machine rules, cross-run
reads, delivery paths, migrations with backfills. Assign the rest, including each cohort's root,
whose own turn mostly integrates, to the ordinary Agent. Judge each slice on its own; a complexity
estimate alone is a poor guide, and a rule such as "the root takes the strongest Agent of its
children" puts nearly everything on the most expensive one. Pick each Agent in the manifest;
to move a ticket to another Agent later, name `team_member_id` in a `pidgen ticket edit --format json` file, or
on the child in a revised child plan (see "Revise or repair an existing child plan").

## File each cohort as one manifest

A new cohort is one ticket manifest: the high-level root, every child, the edges among the
children and where they are filed. Nothing exists on the server until the commit, and the commit
writes everything or nothing, so do not create the root or its children one by one. Inspect the
Project and workflow types, then write the annotated template with one child per slice:

```console
pidgen project show EXAMPLE --format json
pidgen ticket types --format json
pidgen manifest template --children 2 -o cohort.yaml --format json
```

Replace the placeholders. Every comment in the template says the readiness points a field earns:
a ticket runs only with 60 of 100 points and an `estimated_complexity`. A child lands at
`implementation_ready`, which earns it 15 more. For example:

```yaml
schema_version: pidgen.ticket-manifest.v1
project_id: EXAMPLE
epic_id: null
merge_policy: null
promote: false
summary: First slice and a follow-up in one workspace.
root:
  ref: root
  title: Sign-in for the web app
  objective: Let a user sign in with an email and password.
  workflow_type: implementation
  estimated_complexity: 5
  team_member_id: AGENT-EXAMPLE-ROOT
  acceptance_criteria:
    - statement: A user signs in with an email and password.
children:
  - ref: first
    title: First slice
    objective: Deliver the first observable behavior.
    workflow_type: implementation
    estimated_complexity: 3
    context_artifacts:
      - type: brief
        tier: stage
        content: |
          Files to change: src/first.ts.
          Pattern to copy: how src/existing.ts registers its handler.
          Contract rows: the first row of the published API document.
          Narrowest test: tests/first.test.ts.
    acceptance_criteria:
      - statement: The first behavior is covered by local tests.
  - ref: follow-up
    title: Follow-up slice
    objective: Extend the first behavior.
    workflow_type: implementation
    estimated_complexity: 3
    acceptance_criteria:
      - statement: The follow-up behavior is covered by local tests.
edges:
  - source: first
    target: follow-up
    dep_type: blocks
```

Each child has a `ref` unique in the manifest; edges, findings and the commit result use it.
`target` depends on `source`; an edge names children only, never the root, which waits for its
children anyway, and blocks edges may not form a cycle. `epic_id` names the Epic to file the root
in, by its ticket key or id, or `null`; it becomes the root's `parent_ticket_id`. Children take the
root's Project, Epic and approval mode.

The root's `team_member_id` is an **Account Agent ID, not a model name**, a non-empty string of at
most 80 characters. Omitted, the root uses the Project default, else the Account's reserved
Unassigned Agent; null is refused. A child omitting it takes the Agent the root's chain assigns.
The Agent is chosen when the ticket is created; to move a filed ticket to another Agent, name
`team_member_id` in a `pidgen ticket edit --format json` file. Pick each Agent before committing.
Assignment eligibility and active-run effects belong to the server.

### Preview, confirm and commit

`pidgen manifest apply -f cohort.yaml --format json` previews the whole manifest and changes nothing. The CLI first
checks the file against the manifest schema: an invalid file exits 2 with `INPUT_INVALID`, each
issue located in the file (`$.children[0].ref`), and sends nothing. The server checks the whole
manifest and reports every finding at once. Read `data.committable`, `data.promotable`,
`data.preview_digest`, `data.required_acknowledgements`, `data.findings` (grouped by ref:
`manifest`, then the root's ref, then each child's) and the server's resolved `plan`.

Show the person every finding and the plan: the root and each child with its workflow type,
selected Agent and readiness, and the edges. Fix every finding the preview reports, then preview
again. A preview that is not committable exits 5 with `MANIFEST_NOT_COMMITTABLE`, and no commit is
sent; `error.details` carries the same report, and `blocking` lists the codes that block the
commit. With children, a root that is not ready blocks the commit; a child that is not ready
blocks promotion only.

Commit only after the person confirms the preview:

```console
pidgen manifest apply -f cohort.yaml --apply --format json
pidgen ticket show EXAMPLE-12 --format json
```

The commit previews the same file again, then sends the preview's digest and an idempotency key,
so repeating it is safe. Pass `--ack <code>` only for a code the preview listed in
`required_acknowledgements` and the person accepted; never add acknowledgements on their behalf.
`data.tickets` gives each ref's ticket key, the root first; report them. Check `data.settled` and
`data.result` instead of assuming acceptance means completion; `--no-wait` returns a `handle` to
inspect later. A manifest changed since the preview is `PREVIEW_STALE` (exit 6): preview again,
and never retry a stale commit automatically.

`promote: true` promotes the root and its children for execution in the same commit; every
promotion gate must then pass, and a finding that blocks promotion blocks the commit too. Set
`promote: true` only when the person asked for the work to run; filing a cohort is not a request
to execute it. Leave it `false` for a cohort that waits on another cohort (see "Order and promote
cohorts").

The server must publish the manifest routes. Until it does, report that refusal and its
`error.code` to the person instead of filing the cohort piecemeal.

## Attach each child's brief

A child's objective says what outcome it delivers. Give each child a starting brief too: the files
to change, the pattern to copy, the contract rows it must honour and the narrowest test that
proves it. Attach the brief to the child, not by appending it to the objective: the objective
stays short and stable, and the brief can change without rewriting it.

Say too what earlier children leave behind that this one builds on: a fresh session spends much of
its time finding what the planner already knew. Write the brief before filing. Editing a child's
text after promotion is a content change that withdraws its admission and its root's, so the
cohort has to be promoted again.

Name only the tests that prove the child's own criteria. Never tell a child to finish by running
the project's whole test suite, and never make a full-suite run one of its acceptance criteria or
success metrics: a child that runs the whole suite spends minutes on every attempt proving work
that is not its own.

In a manifest, a child's brief is a `context_artifacts` item with `type: brief` and `tier: stage`,
as in the example above. Check that the preview's `plan` gives each child the brief you wrote.

In a revised child plan (see "Revise or repair an existing child plan"), use one form per child,
never both:

- `brief_file: <path>` names a file, with a path relative to the plan file (relative to the working
  directory when the plan is read from standard input). The CLI reads it and sends its text as one
  brief. The text must have 1 to 8192 characters.
- `context_artifacts` lists briefs inline: at most 3 items, each `type: brief`, `tier: stage`, a
  `content` of 1 to 8192 characters and an optional `reference_url`. They are sent unchanged.

A missing, empty or oversized brief file is a usage error (exit 2, `INPUT_INVALID` at
`$.children[<n>].brief_file`) before any request, and so is another `type` or `tier`, a fourth
item or content over the limit. For a kept child, the stored briefs change only when the plan
names `context_artifacts` or `brief_file` for it, so to keep a kept child's brief, leave both out.
The server must publish the field. Until it does, a real server refuses a plan that carries a
brief: report that refusal and its `error.code` to the user instead of moving the brief into the
objective.

## Order and promote cohorts

File cohorts in dependency order. Root-to-root blocking edges between cohorts use
`pidgen ticket dep add --format json`, since a manifest has one root and its edges join its own children only.
Commit a cohort that waits on another with `promote: false`, then add the edge between the two
filed roots:

```console
pidgen ticket dep add EXAMPLE-20 --on EXAMPLE-12 --format json
```

Here root `EXAMPLE-20` waits for root `EXAMPLE-12`. Only once its root-to-root edges are present,
and only when the person asked for execution, promote that filed root. Promotion is governed:

```console
pidgen plan promote EXAMPLE-20 --format json
pidgen plan promote EXAMPLE-20 --apply --digest <promotion_preview_digest> --format json
```

Promote only within the person's authorized scope and when the preview's gates pass. Read failing
gates and repair targets; do not bypass them. Use `pidgen-manage-epics` when the cohorts also belong in an
Epic, or when one Epic must wait for another.

## Revise or repair an existing child plan

A manifest files new work only. To revise the children of a root that already exists, change its
child plan:

```console
pidgen plan show EXAMPLE-12 --format json
pidgen plan template -o child-plan.yaml --format json
```

The plan is a complete replacement: include every child to retain. A kept child uses its
`plan_item_id` from `pidgen plan show --format json`; a new child uses a unique caller-chosen `key`. Set exactly
one. Supply each child's title, objective and registered workflow type. Dependencies refer to
those keys or plan item IDs; `target` depends on `source`. For example:

```yaml
summary: Add a third slice to the cohort.
children:
  - plan_item_id: ITEM-EXAMPLE-KEPT
    title: First slice
    objective: Deliver the first observable behavior.
    workflow_type: implementation
    context_artifacts:
      - type: brief
        tier: stage
        content: |
          Files to change: src/first.ts and src/settings.ts.
          Pattern to copy: how src/existing.ts registers its handler.
          Contract rows: the first row of the published API document.
          Narrowest test: tests/first.test.ts.
    acceptance_criteria:
      - statement: The first behavior is covered by local tests.
  - key: third
    title: Third slice
    objective: Extend the first behavior to the settings page.
    workflow_type: implementation
    brief_file: briefs/third.md
    acceptance_criteria:
      - statement: The third behavior is covered by local tests.
dependencies:
  - source: ITEM-EXAMPLE-KEPT
    target: third
    dep_type: blocks
```

Here the kept child's brief is replaced and the new child reads its brief from a file. A current
child omitted from the replacement will be superseded. Do not replace a kept child with
a new key just to edit it. A child may name `team_member_id` to select its Agent. Omitted, a kept
child keeps its Agent and a new child takes the Project default. A kept child that has already
started keeps its Agent: selecting another is refused with `PLAN_ITEM_AGENT_FIXED` (exit 5).

```console
pidgen plan apply EXAMPLE-12 -f child-plan.yaml --format json
pidgen plan apply EXAMPLE-12 -f child-plan.yaml --apply --digest <preview_digest> --format json
```

The first command previews: read `data.plan`, `effects`, `required_acknowledgements` and
`preview_digest`, and show the person the new, retained and superseded children and the
dependencies. Apply only after the person confirms, with the preview's digest; do not invent it.
Only pass `--ack supersedes-children` if the preview required `supersedes_children` and the person
has authorized superseding the listed children. Check `data.settled`, `data.result.status` and any
refusal, then confirm with `pidgen plan show --format json`.

Regrouping independent roots into a cohort requires a concrete supersession plan; do not leave
duplicate runnable work behind. Accepted or active work may be refused by the server, so surface
that result.

## Errors

Local shape errors exit 2 before any request. Public authorization errors exit 3; an unknown
Project (`PROJECT_NOT_FOUND`) or an unknown or foreign Agent reported as 404 exits 4; a manifest
that is not committable, a failed promotion gate, and assignment or version refusals reported as
409 exit 5; `PREVIEW_STALE` or a missing digest or acknowledgement exits 6. Preserve `error.code`
and details. Preview again after stale evidence; never retry a stale write automatically or fall
back to an admin route. Return each root reference, the committed tickets and any remaining
server gate.
