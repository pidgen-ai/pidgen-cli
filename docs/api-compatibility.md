# API compatibility

## The public API

The App Service publishes a subset of its HTTP API as the **public API**, described by an OpenAPI
document served unauthenticated at `GET /api/v1/openapi.json`. Only routes in that document are
covered by the compatibility promise below, and the CLI calls only those routes.

Each CLI release carries a copy of the document it was built against. Request bodies are validated
against its schemas before they are sent (`INPUT_INVALID`, exit 2), and answers after
(`UNEXPECTED_RESPONSE`, exit 1). A command that needs a route or a field the server does not
publish waits for it and is marked *planned* ([Not yet published](#not-yet-published)).

`pidgen skills status` compares this document with the configured server's: it reads
`GET /api/v1/openapi.json` without a credential and reports in `data.contract` whether the two
are the `same` or `different` — by `info.version` and by a `sha256:` digest of the document with
its keys sorted — and the operations (`METHOD /path`) only one side has. A server that cannot be
read leaves the contract `unchecked`, with the reason, and the command still exits 0. The two differ
when the server has moved on since the CLI was released; a newer CLI release catches up.

The Ticket actions routes are `GET /tickets/{ticket_id}/actions` (filters `family` — `recovery`,
`run_control` or `ticket_control` — `run_id`, `node_id` and `prerequisite_id`) answering
`{ticket_id, actions: [ActionDecision]}`; `POST /tickets/{ticket_id}/actions/preview` with
`{action, target}` answering `ActionPreviewResult` (`preview_digest`,
`required_acknowledgements`, `action`, `target`, `consequence`, `effects`); and
`POST /tickets/{ticket_id}/actions/execute` with `ActionExecuteRequest` (`preview_digest`,
`idempotency_key` of 1–255 characters, at most 20 `acknowledgements`, `reason` of at most 10240
characters, `note` of at most 4000, `action`, `target`) answering `200` when settled or `202` while
applying, each with `ActionExecuteResult` (`command_id`, `ticket_id`, `status`,
`disposition_code`, `workflow_run_id`, `status_url`, `action`, `target`; no `result` object). An
`ActionTarget` names its `kind` (`ticket`, `run`, `node` or `dependency`) and `ticket_id`, and
optionally `run_id`, `node_id`, `fan_out_key` and `prerequisite_id`. Each `GET /attention` finding
carries `target`, `label`, `prerequisite_id` and its `actions`, and has no `action` field. The
older recovery routes, whose request names its `action` (not a mode), stay in the document; the
CLI does not call them.

## Domains, contracts, Requests and worker releases

The domain, Domain Epic, contract, contract publishing, Request and worker release routes are in the
published document, and the CLI validates what it sends to them and what they answer against it.
What the commands read:

- **Domains** (`/api/v1/domains`, `/api/v1/domains/{domain_id}` and its `projects`, `parents` and
  `people` routes): a list answers `DomainResource`s and one domain a `DomainDetail` (the resource
  and `granted`, the people granted on it). A domain counts its people under `people`
  (`members`, `maintainers`) and its Epics under `epics` (`open`, `total`). The people routes take
  the person's user id (a UUID). The domain key's format is stated in prose only, so a key the
  server refuses is its `DOMAIN_KEY_INVALID` (exit 2), not a client-side check.
- **Domain Epics**: `POST /api/v1/tickets` with `domain_id` instead of `project_id` (the published
  `CreateTicketRequest` carries `domain_id`) and `GET /api/v1/domains/{domain_id}/epics`, answering
  a `DomainEpicBoard`.
- **Contracts**: `GET /api/v1/projects/{project_ref}/contracts` answers `provides` and
  `builds_against` (a Project's list has no coverage); `GET /api/v1/domains/{domain_id}/contracts`
  answers `own`, `coverage` (by `provider`) and `builds_against`. Each entry names its `provider`
  by `project_id`, `kind` (`project` or `domain`), `domain_id`, `key` and `name`, and its owner by
  `owner_user_id`. `GET /api/v1/contracts/{contract_id}`, `POST …/revisions` and
  `POST …/revisions/{revision_number}/accept` answer the whole contract (`ContractDetail`); a
  revision's `operations` are `{name, types?}` and its request requires `schema_format`. A
  contract read states each operation's state in `operation_states` (`{name, state}`, `state`
  `landed`, `pending` or `removed`). The link routes `POST /api/v1/tickets/{ticket_id}/contracts`
  and `DELETE /api/v1/tickets/{ticket_id}/contracts/{contract_id}` answer the Ticket's contracts.
- **Creating a contract**: `POST /api/v1/projects/{project_ref}/contracts` and
  `POST /api/v1/domains/{domain_id}/contracts` take a `ContractCreateRequest` (`title`, `kind`,
  `markdown`, `schema_format`, `native_schema`, `operations`, `owner_user_id`,
  `describes_existing`) and answer 201 with the created contract (`ContractResponse`).
- **Publishing contracts**: `POST /api/v1/projects/{project_ref}/contracts/publish` and
  `POST /api/v1/domains/{domain_id}/contracts/publish` take multipart `file` (the entry) and
  repeated `files` named by their relative paths, with `source_path`, `format`, `commit`, `ref`,
  `source_kind` (`upload` or `ci`), `breaking`, `title` and `dry_run`, and answer a
  `ContractPublishResult`: the `outcome` (`created`, `revised` or `unchanged`), `contract_id` and
  `contract_key`, `revision`, `acceptance`, `change` (`additive` or `breaking`) and
  `change_reason`, the operations and types added and removed, the pending operations `landed` and
  `still_pending`, and `resolved_refusals`. `POST /api/v1/contracts/{contract_id}/proposals` and
  `POST /api/v1/projects/{project_ref}/contracts/proposals` take a fragment file (and a new
  contract's `title`) and answer a `ContractProposalResult` with the operations made `pending` and
  already `landed`. A refused file is a `PublicError`: `CONTRACT_FILE_INVALID`,
  `CONTRACT_FORMAT_UNSUPPORTED`, `CONTRACT_EXTERNAL_REF`, `CONTRACT_CONVERSION_TIMEOUT` (422) or
  `FILE_TOO_LARGE` (413), with `error.details.errors` (`{message, location}`) and, for a publish
  that is not a dry run, `error.details.refusal_id`.
- **Requests**: `POST /api/v1/requests` (a `RequestSubmitRequest`; 201 new or 200 deduplicated,
  answering a `RequestReceived` with the `outcome`, `entry_id` and `occurrence_id`),
  `GET /api/v1/requests` (filtered by `state`, `kind`, `target_kind`, `target_id`, `source_id` and
  `q`, paged), `GET /api/v1/requests/{request_id}`, `GET /api/v1/requests/{request_id}/timeline`
  (each entry with its `author`, the ids of its `attachments` and its `files`), the triage writes
  `acknowledge`, `ask`, `reply`, `accept`, `close` and `promote` (each carrying the `version` it
  read), and `POST /api/v1/requests/{request_id}/attachments` (multipart). A Request's `requester`,
  `source`, `target` and `urgency` may be null; `close` takes a `reason` from a fixed list, and
  `promote` goes to the Project the Request targets, `project_id` only confirming it.
- **Worker releases**: `GET /api/v1/workers/releases`, read with no credential and no Account,
  answering a `WorkerReleaseList`.

## Not yet published

These features wait for the public API to publish what they need, and are marked *planned* where
they would appear:

- **Artifact uploads.** `SteerRequest` and ticket creation take `upload_ids`, but the route that
  stages an upload (`POST /artifact-uploads`) is not in the public document. `pidgen session steer
  --upload` is *planned* until the server publishes it; the CLI has no `--upload` flag.
- `pidgen ticket list --epic` remains *planned*. The published ticket list supports a
  `parent_ticket_id` filter; the CLI does not yet expose it as `--epic`.

## Version negotiation

- The CLI sends `PIDGEN-API-Version: <major>.<minor>` on every request.
- The server accepts its current minor version and the previous minor of the same major, and echoes
  the negotiated version in the response header of the same name. `meta.api_version` in the
  envelope shows it.
- Anything else is refused with `426` and `API_VERSION_UNSUPPORTED`, which names the supported range
  and how to upgrade. The CLI exits 7.
- `GET /api/v1/health` reports `api_version.current` and `api_version.minimum`. `pidgen auth login`
  checks it before sending credentials, and `pidgen auth status` shows it. Only after that check does
  `pidgen auth login` send the new credential, to verify it before storing it (`GET /api/v1/me` for a
  CLI token, `GET /api/v1/projects` for a Personal API Token). `pidgen auth status` and
  `pidgen account list` send a CLI token only to `GET /api/v1/me`, and `pidgen auth list` and
  `pidgen auth revoke` send one to `GET /api/v1/me/sessions` and
  `DELETE /api/v1/me/sessions/{session_id}`; none of them sends a Personal API Token there.
- Breaking changes to the public API are announced at least 30 days ahead.

## CLI releases

Each CLI release states the API version range it supports, in `pidgen --version` and the changelog.
The CLI follows semantic versioning: a major release changes or removes commands, flags, envelope
fields, exit codes, CLI error codes, or skills in an incompatible way.
