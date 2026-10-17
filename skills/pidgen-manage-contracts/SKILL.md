---
name: pidgen-manage-contracts
description: Put an interface between Projects into Pidgen as files. Publish or upload an API spec (OpenAPI, AsyncAPI) with pidgen contract publish, run --check first and set up CI to keep it current; propose an interface another Project needs, from a fragment file, with pidgen contract propose; check whether a proposed addition has landed; find out what another Project offers before building against it; link the provider's and consumers' work to it. Use when asked to publish, upload, create, define, propose or announce a contract or an interface, to wire contract publishing into CI, or when cross-Project work would share one interface. A contract is optional; for one consumer ticket, attaching the spec file or stating the interface in its scope is enough (pidgen-file-ticket, pidgen-decompose-plan).
---

Use `--format json` for structured CLI responses, including when stdout is a terminal.

# Publish and propose contracts

A contract is an interface one Project (or a Domain) provides and other work builds against: a REST
API, an event channel, a library's surface. Pidgen keeps it with revisions, each naming its
operations, and a ticket linked to a contract gets the contract's accepted revision in its runs
automatically.

A contract enters Pidgen as a file. A **published** revision is converted from a spec file that
describes code that exists; a **proposed** revision comes from a fragment file for an interface
that does not exist yet. Each operation of a contract is `landed` (in the newest published
revision), `pending` (proposed and accepted, not yet published) or `removed` (in an earlier
published revision and not in the newest).

## Choose the path

First look for a contract that already describes the interface with `pidgen contract list --format json` (see
"Find one first"); then choose:

| Situation | Do |
|---|---|
| A spec file describes code that exists | Publish it with `pidgen contract publish --format json`, and set up CI |
| Another Project needs an interface that doesn't exist yet | Propose a fragment with `pidgen contract propose --format json` |
| One piece of work needs an interface once | Attach the spec file to the ticket, or state the interface in its scope; no contract needed |
| Work calls an interface that already has a contract | Find it with `pidgen contract list --format json` and `pidgen contract show --format json`, then link the work |

**Never write a schema into a command, a body or a ticket.** Pass the file path; the CLI moves the
bytes. For a proposal, write only the fragment the need asks for, in a file, and pass the file.
Never copy an existing spec's text, and never use `pidgen contract revise --format json` to store a spec that
exists as a file. The CLI never reads a spec into `native_schema`, and neither should you.

## When a contract is worth it

A contract is never required. Cross-Project work carries the provider's interface one of three
ways: attach the spec file to the consumer ticket, state the interface in its scope, or link a
contract. Make one when the interface is:

- **shared by several pieces of work**: more than one consumer ticket, or work in more than one
  Project, builds against it;
- **likely to change**: a revision then reaches every linked ticket, and a breaking one is visible
  as such, instead of each ticket carrying its own stale copy;
- **worth announcing**: other teams should be able to find it with `pidgen contract list --format json` and see
  who implements it and who builds against it.

Do not make one for a single consumer of an interface that will not move. Then either attach the
spec file to the ticket (a `context_artifacts` item with a `reference_url` to it, or the file
committed as a fixture in the consumer's own workspace), or state the interface in its scope:
name in prose the operations, fields and errors the ticket relies on. Both keep every criterion
provable from the consumer's own workspace (`pidgen-decompose-plan`, "Work that spans Projects").

## Find one first

Look for a contract that already describes the interface before publishing or proposing another:

```console
pidgen contract list --project ALPHA --format json
pidgen contract list --domain EXAMPLE --format json
pidgen contract show CT-7 --format json
```

`pidgen contract list --project ALPHA --format json` answers `{provides, builds_against}`: the Project's own
contracts and those its work builds against. `pidgen contract list --domain EXAMPLE --format json` answers
`{own, coverage, builds_against}`, the coverage grouped by `provider`. Each entry has its `key`,
`title`, `kind`, `status` (`deprecated` entries name their replacement) and
`newest_accepted_revision`. `pidgen contract show CT-7 --format json` reads one: its `revisions`, its
`operation_states` (each operation's `name` and `state`), and the work in `implemented_by` and
`built_against_by`.

- One fits as it is: link the work to it (see "Link work to it").
- One fits but lacks an operation: propose the operation (see "Propose an interface that doesn't
  exist yet") rather than making a second contract for the same interface.
- The provider's spec file exists and no contract has it: publish it.

## Publish a spec file that describes existing code

Publishing takes an OpenAPI (2.0, 3.0, 3.1) or AsyncAPI (2.x, 3.x) file from the provider's
repository. The first publish of a file's path creates the contract, a later one revises it, and
the same document again changes nothing. Run `--check` first: it is the dry run and records
nothing.

```console
pidgen contract publish contracts/public-api/openapi.json --project ALPHA --check --format json
```

Read `data.outcome` (`created`, `revised` or `unchanged`), `data.change` (`additive` or
`breaking`) and `data.change_reason` (why), `data.added`, `data.removed`, `data.types_removed`,
`data.landed` (the pending operations this publish would land) and `data.still_pending` from the
envelope. `unchanged` means there is nothing to do.
A breaking change exits 5 with `CONTRACT_CHANGE_BREAKING`, the dry run's answer in
`error.details.result`. Stop and ask the person before publishing a breaking change: removing an
operation or a type breaks every consumer building against it. Give `--breaking` only when the
person has agreed to it.

Then publish:

```console
pidgen contract publish contracts/public-api/openapi.json --project ALPHA --format json
```

- Give exactly one of `--project` (the provider Project) and `--domain` (a Domain's id, for an
  interface the Domain provides).
- The CLI sends the file with every `.json`, `.yaml` and `.yml` file under its directory, so
  relative `$ref`s resolve; `--include 'schemas/**'` sends only the files matching a glob.
- The contract is identified by the file's path relative to the repository root; outside a
  repository give `--path`. Keep the path stable: a moved file publishes a new contract.
- Publish from the default branch only: a published revision says the code exists, and that is
  what makes its operations landed.

## Propose an interface that doesn't exist yet

When another Project needs an interface it does not offer yet, write a fragment file in the
contract's format holding only the operations the need asks for, not the provider's whole API. The
App takes the operations from the file, so nobody lists them by hand. The CLI sends the files beside
it as a publish does, so a fragment may `$ref` schemas in its directory (`--include` narrows them):

```yaml
openapi: 3.1.0
info:
  title: Payment status
  version: 0.1.0
paths:
  /payments/{payment_id}:
    get:
      operationId: getPaymentStatus
      parameters:
        - name: payment_id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: The payment's status, pending, settled or failed.
        "404":
          description: PAYMENT_NOT_FOUND, no such payment.
```

Check it, then propose it as a revision of the contract it extends, or as a contract the provider
Project is to provide when none exists:

```console
pidgen contract propose CT-7 payment-status.openapi.yaml --check --format json
pidgen contract propose CT-7 payment-status.openapi.yaml --format json
pidgen contract propose --project ALPHA --title "Payment status" payment-status.openapi.yaml --format json
```

`data` names the operations the proposal made `pending` and those the newest published revision
already has (`landed`): a landed one needs no proposal, so build against it. The proposed revision's
`acceptance` is `automatic`, or `waiting` when the Account's Contract approval setting asks a
person to accept it; then whoever the server allows accepts it with `pidgen contract accept CT-7 --format json`,
and linked work waits until then. Never make that acceptance a criterion or a step of any ticket.

## Set up CI

Do this with the person's agreement, because it edits their pipeline. Find the pipeline: look for
`.github/workflows/`, `.gitea/workflows/` and `.gitlab-ci.yml`. Add a publish on pushes to the
default branch and a `--check` on pull requests, one line per spec file:

```yaml
# on push to the default branch
- run: npx pidgen contract publish contracts/public-api/openapi.json --project ALPHA --commit "$GITHUB_SHA" --ref "$GITHUB_REF" --format json
  env:
    PIDGEN_API_URL: ${{ vars.PIDGEN_API_URL }}
    PIDGEN_ACCOUNT: ${{ vars.PIDGEN_ACCOUNT }}
    PIDGEN_TOKEN: ${{ secrets.PIDGEN_TOKEN }}
# on pull requests
- run: npx pidgen contract publish contracts/public-api/openapi.json --project ALPHA --check --format json
  env:
    PIDGEN_API_URL: ${{ vars.PIDGEN_API_URL }}
    PIDGEN_ACCOUNT: ${{ vars.PIDGEN_ACCOUNT }}
    PIDGEN_TOKEN: ${{ secrets.PIDGEN_TOKEN }}
```

Read `PIDGEN_API_URL`, `PIDGEN_ACCOUNT` and `PIDGEN_TOKEN` from the pipeline's variables and
secrets. Tell the person to create a Personal API Token and store it as the `PIDGEN_TOKEN` secret;
never write a token into a file. Under `CI=true` the CLI records the publish as from CI. GitLab's
`$CI_COMMIT_SHA` and `$CI_COMMIT_REF_NAME` take the place of the GitHub variables.

## Read landed and pending

`pidgen contract show CT-7 --format json` lists each operation in `data.operation_states` with its state:
`landed`, `pending` or `removed`. A root that builds against
a pending operation builds against a mock of it in its own workspace; a landed one is the real
interface.

After the implementing work merges, the next publish from the default branch should land its
operations, and `data.landed` names them. If the contract reports an operation as merged, but not
in the published spec, compare the operation's name and path in the fragment with the published
file, then fix the spec or the CI line; don't re-propose.

## Revise its document

`pidgen contract revise --format json` is for prose revisions of the contract's Markdown, never for a spec:

```console
pidgen contract revise CT-7 -f revision.yaml --markdown payment-status.md --format json
```

```yaml
kind: rest
schema_format: prose
change: additive
operations:
  - name: getPaymentStatus
```

`change` is `additive` or `breaking`; say `breaking` when existing consumers must change. `data` is
the contract with its new revision last, `automatic` or `waiting` as above.

## Link work to it

Link the provider's delivery root to the contract it implements, and each consumer's root (or its
Epic) to the contract it builds against, naming the operations it uses:

```console
pidgen ticket contract implements ALPHA-40 CT-7 --format json
pidgen ticket contract builds-against BETA-12 CT-7 --operation getPaymentStatus --format json
```

Link a cohort's root, never its children (`CONTRACT_LINK_INSIDE_COHORT`). A link never blocks and
orders nothing: the consumer still builds against fixtures of the contract in its own workspace,
and live integration belongs in the external QA plan (`pidgen-decompose-plan`, "Link each cohort's
root to the contract", lists the link refusals).

## Errors

A refused file exits 5 and prints every error with its location; `error.details.errors` holds them
as `{message, location}`. A publish refused when it is not a dry run is also announced in the Inbox
with the refused file, named by `error.details.refusal_id`.

| Code | Means | Do |
|---|---|---|
| `CONTRACT_FILE_INVALID` | The file won't parse or fails validation; every error is listed with its location | Fix the spec at each location; never hand-trim it to get past the check |
| `CONTRACT_EXTERNAL_REF` | A `$ref` is a URL, a `file:` URL, an absolute path, or a path outside the files sent | Send the file with `--include`, or inline it |
| `CONTRACT_FORMAT_UNSUPPORTED` | Not OpenAPI or AsyncAPI | Attach the file to the work instead |
| `CONTRACT_CONVERSION_TIMEOUT` | The spec took longer than 60 seconds to validate | Publish per service or resource, one file each |
| `FILE_TOO_LARGE` | Over 8 MiB or 200 files | Publish per service or resource, one file each |
| `CONTRACT_CHANGE_BREAKING` | `--check` found a breaking change | Stop and ask the person; add `--breaking` only once they agree |
| `CONTRACT_NOT_FOUND`, `PROJECT_NOT_FOUND`, `DOMAIN_NOT_FOUND` | No such contract, Project or Domain (exit 4) | Check the key with `pidgen contract list --format json` |
| `FORBIDDEN` | No role in the provider (exit 3) | Ask a provider Project member; never publish it somewhere else |

`CONTRACT_RETIRED` (exit 5) refuses a revision of a retired contract.
