# Changelog

## Unreleased

## 0.1.0-alpha.1

The first published release, an alpha, published to npm under the `alpha` dist-tag. Nothing was
published before it: changes marked breaking below are breaking only against earlier unpublished
builds. Install it with `npm install -g pidgen@alpha`. Until the first release, `latest` points at
the newest alpha too, so `npm install -g pidgen` installs the same version.

### The docs bundle for docs.pidgen.ai

- **`npm run docs:check`** (`scripts/docs-bundle.mjs check`) checks `docs/` against the docs bundle
  contract the docs site renders: every page but `README.md` listed once in `navigation.json` and
  every listed page present, each page titled by its `#` heading, relative links and `#anchors`
  resolving by GitHub's heading slugs, and no private material (internal citations, localhost or
  LAN addresses, `/home/` or `/srv/` paths, internal names, Account ids other than `ACC-EXAMPLE`,
  credentials). CI and the release workflow run it before the build.
- **`npm run docs:pack`** (`scripts/docs-bundle.mjs pack [dir] [--out <dir>]`) checks `docs/`, then
  writes the docs bundle `pidgen-cli-docs-<version>.tar.gz`: `docs-bundle.json` (format 1, product
  `cli`, the `package.json` version and the git commit), `navigation.json`, `README.md` and the pages
  it lists. Links that leave `docs/` (`../CONTRIBUTING.md`, `../skills`) point at the tagged public
  repository, `https://github.com/pidgen-ai/pidgen-cli/blob/v<version>/<path>`. The release workflow
  packs after `npm publish` and attaches the bundle to the tag's GitHub release, so docs.pidgen.ai
  can render the docs of the release people install.
- The worker guides ([Install and connect a worker](docs/install-worker.md),
  [Workers](docs/workers.md)) hand off to the worker's own docs for what runs on the machine:
  `https://docs.pidgen.ai/worker/configure/`, `/coding-agents/`, `/troubleshooting/` and
  `/run-as-a-service/`. The CLI pages keep install, enroll, start, stop, update and status.

### Token prefixes and documentation

- **`PIDGEN_TOKEN` recognises the `pidgen_cli_` and `pidgen_pat_` prefixes** the server issues, and
  still `awes_cli_` and `awes_pat_` for tokens issued before. A `pidgen_` token in `PIDGEN_TOKEN`
  was an unrecognised kind: `pidgen auth status` and `pidgen account list` did not ask the server
  who you are, and `pidgen doctor` and `pidgen setup` could not tell whether it may enroll workers.
- The rules for writing a skill move from `docs/skills.md` to `CONTRIBUTING.md`; `docs/skills.md`
  describes the bundled skills for the people who install them. `docs/api-compatibility.md` drops
  contributor detail, and the README's logo shows in light mode.
- `npm run api:coverage` attributes the contract create, publish and propose routes and the Request
  routes to the commands that send them.
- The README and docs install `pidgen@alpha`, and `pidgen doctor` suggests upgrading on the CLI's own
  channel (`npm install -g pidgen@alpha` from an alpha, `pidgen@latest` from a stable release).
- **Onboarding guides.** New guides take a person from installing the CLI to reading their
  Account's work (`docs/getting-started.md`), installing the agent skills (`install-skills.md`),
  setting up a worker (`install-worker.md`) and fixing common problems (`troubleshooting.md`). The
  docs index groups the pages into Getting started, Guides and Reference, with a navigation
  manifest (`docs/navigation.json`) for the website. The README introduces Pidgen to prospective
  customers and lists the bundled skills.

### Breaking: contract creation, contract publishing and Requests use the published routes

- **The last three pending fragments are gone.** The server publishes the contract creation,
  contract publishing and Request routes, so `contracts/openapi.json` is pulled again and
  `contracts/pending/contract-create.json`, `contract-publish.json` and `requests.json` and their
  generated types are deleted. `pidgen contract create`, `publish`, `propose` and `show` and every
  `pidgen request` command are typed from and validated against the published document. Built
  against the fragments, they would have refused the server's answers with `UNEXPECTED_RESPONSE`.
- **`pidgen contract publish`** answers the published `ContractPublishResult`: `outcome` (was
  `status`), `contract_id` and `contract_key` (was `contract`), `acceptance`, `change` as
  `additive` or `breaking` with `change_reason` (was `{kind, declared, why}`), the file's `format`,
  `version`, `title` and `source_path`, `operation_count`, `type_count`, `types_added`,
  `types_removed`, `still_pending` (was `pending`, a list of names) and `resolved_refusals`; there
  is no `source` or `refusal_id`. `--check` names the `change_reason` when it refuses a breaking
  change.
- **`pidgen contract propose`** answers `contract_id` and `contract_key` (was `contract`), the
  fragment's `format`, `version`, `title` and `operations`, beside `pending` and `landed`.
- **`pidgen contract propose` sends the files beside the fragment**, as `publish` does (every
  `.json`, `.yaml` and `.yml` file under its directory, or `--include <glob>`; at most 200 files and
  8 MiB), so a fragment's relative `$ref`s resolve instead of being refused with
  `CONTRACT_EXTERNAL_REF`. `pidgen contract create --schema` without `--existing` does the same and
  sends `--schema-format` as the proposal's `format`.
- **`pidgen contract show`** lists each operation's state in `operation_states` (`{name, state}`;
  was `operations`, with `implemented_by` and `removed_in`).
- **`pidgen request show`**: each timeline entry's `author` is `{actor, name, contact}`,
  `attachments` lists file ids and `files` the files; a Request's `requester`, `source` and
  `urgency` may be null.
- **`pidgen request close --reason`** takes one of `cannot_reproduce`, `wont_do`, `duplicate`,
  `invalid`, `answered`, `no_response`, `withdrawn` and `other`; another is `CLI_USAGE` (exit 2).
- **`pidgen request promote`** promotes into the Project the request targets: `--project` is
  optional and confirms it. `REQUEST_TARGET_NEEDS_PROJECT` now means the request does not target
  that Project, or targets a Domain or nothing.
- **Skill contract change:** `pidgen-manage-contracts` reads `outcome`, `change_reason`,
  `still_pending` and `operation_states`, and `pidgen-triage-requests` the timeline's `files`, the
  close reasons and promotion into the targeted Project. Run `pidgen skills install` to update
  installed copies.
- Contract tests now run against Prism serving the published document, including
  `pidgen contract publish` and `propose`.

- The CLI's copy of the public API contract (`contracts/openapi.json`) and its generated types no
  longer carry the retired legacy Epic routes (`/api/v1/epics`, `/api/v1/epics/{epic_id}`, its
  `dag` and `dag/edges`, and `POST /api/v1/tickets/{ticket_id}/epic`) or the schemas only they
  used, so `npm run api:coverage` no longer lists them. No `pidgen epic` command sent them: every
  one uses the ticket routes. `npm run contract:pull` leaves them out, and says so, while an App
  Service still publishes them. The Domain and Project Epic reads are unchanged.

### Output and presentation

- Authentication, Account, worker, setup and skill-status results now have labeled lifecycle
  summaries. Human failures retain supplied diagnostic checks, fixes, blocking findings and recovery
  actions; successful results retain warnings and incomplete contract/service checks. Subscription
  output retains connection, login errors and complete quota/pause observations beside summaries.
  Textual help/version, foreground worker handoff and established stderr streams are unchanged.
  Contributors can audit every registered operation in the presentation inventory in CONTRIBUTING.md.

- Mutation output explains unapplied previews and copyable application requirements, distinguishes
  settled changes from pending operations and timed-out waits, and retains created keys, promotion
  state, findings and recovery details. JSON responses and mutation safeguards are unchanged.

### Breaking: terminal output defaults

- **Breaking against earlier builds:** terminal stdout now defaults to human-readable
  responses. Nonterminal stdout (pipes, redirects and captures) continues to receive exactly one
  JSON envelope. Use `--format json` to retain JSON in automation in every environment;
  `--format table` explicitly selects human output. JSON fields, payloads, metadata, errors and exit
  codes remain unchanged, including usage failures. Help/version text and foreground worker streams
  keep their existing behavior.
- Resource reads identify collections and displayed counts, show compact identifying fields, and
  label details, prerequisites, findings, attempts, artifacts, evidence and long text. Narrow
  terminals use numbered records and wrapped prose while keeping actionable values complete.
  Paths containing spaces remain copyable inside arrays; installation summaries and preview
  guidance wrap prose without splitting destinations or application flags.
- Skill installation summarizes distinct skills, destinations, agents and installation records,
  lists outcomes by destination, and explains preserved locally edited copies.
- **Skill contract change:** all bundled skills explicitly request `--format json` for structured
  responses, including terminal examples. Run `pidgen skills install` to update installed copies.

### Skills: pidgen-manage-contracts publishes and proposes files

- **`pidgen-manage-contracts` is rewritten around `pidgen contract publish` and
  `pidgen contract propose`.** It chooses publish, propose, attach or link; never writes a schema
  into a command, a body or a ticket, passing file paths instead; runs `publish --check` first and
  stops to ask before publishing a breaking change; sets up CI (`.github/workflows/`,
  `.gitea/workflows/`, `.gitlab-ci.yml`) with publish on the default branch, `--check` on pull
  requests and the token as a secret; reads landed and pending operations; and lists every refusal
  code. It no longer teaches reading a schema into `pidgen contract create`.
- **`pidgen-decompose-plan`** says a root that builds against a pending operation builds against a
  mock. Run `pidgen skills install` again to update the installed copies.

### `pidgen contract publish` and `pidgen contract propose`: contracts enter as files

- **`pidgen contract publish <file> (--project | --domain)`** publishes a spec file, with every
  `.json`, `.yaml` and `.yml` file under its directory (or `--include <glob>`), as multipart. The
  contract is identified by its source path, by default the file's path relative to the repository
  root (`--path` overrides); `source_kind` is `ci` under `CI=true`, else `upload`; `--commit` and
  `--ref` name where it was read. It prints `created`, `revised` or `unchanged`, the change and why,
  and the operations added, removed, landed and still pending.
- **`--check`** is the dry run for pull requests: exit 0 when additive or unchanged, exit 5 with
  `CONTRACT_CHANGE_BREAKING` on a breaking change unless `--breaking` is given.
- **`pidgen contract propose <contract> <fragment>`** and **`--project <project> --title <title>
  <fragment>`** propose a revision, or a contract that does not exist yet, from a fragment file
  (`--check` for the dry run), and print which operations became pending and which were already
  landed.
- **A refused file** (`CONTRACT_FILE_INVALID`, `CONTRACT_FORMAT_UNSUPPORTED`,
  `CONTRACT_EXTERNAL_REF`, `CONTRACT_CONVERSION_TIMEOUT`, `FILE_TOO_LARGE`) exits 5 and prints every
  error with its location (`error.details.errors`).
- **Breaking: `pidgen contract create --schema <file>`** no longer reads the file into
  `native_schema`: with `--existing` it publishes the file, otherwise it proposes it as a new
  contract (with `--title`). `-f`, `--kind`, `--markdown` and `--owner` cannot be given with it.
- **`pidgen contract show`** lists each operation's state: `landed`, `pending` with its
  implementing ticket, or `removed`.
- **A pending fragment for publishing.** The routes are agreed with the App Service and not yet
  published: the CLI is built against `contracts/pending/contract-publish.json`, typed into
  `src/generated/contract-publish.d.ts`, until they are.

### Skills: pidgen-triage-requests, and pidgen-file-ticket files a request

- **A new bundled skill, `pidgen-triage-requests`,** works the request queue: `pidgen request list
  --state new`, `pidgen request show` (the request and its timeline), then `pidgen request
  acknowledge` or `pidgen request reply --ask`, `pidgen request accept` (`--priority`, and
  `--unknown` for a bug's missing details), `pidgen request close` (`--reason`, with
  `--duplicate-of` or `--note`) or `pidgen request promote --project`. `pidgen skills install`
  installs it with the others.
- **`pidgen-file-ticket` says when to file a request rather than a ticket:** someone outside the
  team asked, the work is not yet judged worth doing, or its target is unclear. It shows
  `pidgen request submit` with a bug's details (`--steps`, `--expected`, `--actual`) and evidence
  files (`--evidence`), and how to read `data.outcome` and `data.url`.

### `pidgen request`: submit, list, show and triage Requests

- **`pidgen request submit`** files a Request (`bug`, `feature`, `task` or `question`) from flags
  or `-f` (a JSON or YAML body, or a text file as the body): `--kind`, `--title`, `--body`,
  `--steps`, `--expected` and `--actual` (a bug's details), `--urgency`, `--target
  project:<id>|domain:<id>`, `--fingerprint` and `--submission-key` (generated when not given). It
  prints the `outcome` (`created`, `appended`, `occurrence` or `regression`) and the Request's page
  `url`, and `--evidence <file>...` uploads each file to the returned occurrence or entry.
- **`pidgen request list`** filters by `--state`, `--kind`, `--target`, `--source` and `--query`
  and follows every page, or reads one with `--page` and `--per-page`. **`pidgen request show`**
  prints the Request, its requester (the contact only when the server gives it) and its timeline
  with attachments.
- **Triage:** `pidgen request reply` (`--ask` to ask a question), `acknowledge`, `accept`
  (`--priority`, `--unknown`), `close` (`--reason`, with `--duplicate-of` for `duplicate` and
  `--note` for `other`, checked before sending) and `promote` (`--project`, `--workflow-type`,
  `--no-refine`) read the Request's version, send it, and print the new state.
- **Refusals:** `REQUEST_NOT_FOUND` exits 4; `REQUEST_VERSION_CONFLICT`,
  `REQUEST_TRANSITION_REFUSED`, `REQUEST_RATE_LIMITED`, `REQUEST_SOURCE_PAUSED`,
  `REQUEST_BUG_DETAILS_REQUIRED`, `REQUEST_TARGET_NEEDS_PROJECT` and `REQUEST_REPLIES_OFF` exit 5,
  whatever the HTTP status, each with its own sentence.
- **A pending fragment for Requests.** The routes are stated by the App Service and not yet
  published, so the commands are built against `contracts/pending/requests.json` (its types in
  `src/generated/requests.d.ts`, written by `npm run contract:generate`); it is deleted once the
  server publishes the routes.

### Skills: pidgen-manage-contracts, and a contract as one of three ways across projects

- **A new bundled skill, `pidgen-manage-contracts`,** teaches when an interface deserves a contract (shared
  by several pieces of work, likely to change, or worth announcing) and when to attach the spec file
  or state the interface in scope instead; finding one first with `pidgen contract list` and
  `pidgen contract show`; creating one with `pidgen contract create` from a spec file or a written
  need; revising it with `pidgen contract revise`; and linking work with
  `pidgen ticket contract implements` and `builds-against`. `pidgen skills install` installs it.
- **`pidgen-decompose-plan` and `pidgen-file-ticket` no longer say a contract cannot be created.** Work that
  spans projects carries the provider's interface one of three ways: attach the spec file to the
  consumer ticket, state the interface in its scope, or link a contract (reused, or created with
  `pidgen-manage-contracts`). A contract is never required.

### `pidgen contract create`

- **`pidgen contract create (--project <project> | --domain <domain>)`** creates a contract a
  Project or a Domain provides, with its first revision, from `-f <file>` (JSON or YAML) and flags
  that override it: `--title`, `--kind`, `--schema-format`, `--schema <file>` (a spec file's text,
  e.g. an OpenAPI document, as `native_schema`), `--markdown <file.md>`, `--owner <user id>` and
  `--existing` (`describes_existing`: the interface already exists in the provider's code). With a
  schema and no markdown it writes the document from the title and format. The body is checked
  against the agreed request before anything is sent (`INPUT_INVALID`, exit 2), and `data` is the
  created contract as `pidgen contract show` prints it.
- **A pending fragment again.** The two create routes are agreed with the App Service and not yet
  published, so the command is built against `contracts/pending/contract-create.json` (its types in
  `src/generated/contract-create.d.ts`, written by `npm run contract:generate`); it is deleted once
  the server publishes the routes.

### Domains and contracts: built against the published API

- **The four pending fragments are gone.** The server publishes the worker release, domain, Domain
  Epic and contract routes, so `contracts/openapi.json` is pulled again and
  `contracts/pending/worker-releases.json`, `domains.json`, `domain-epics.json` and
  `contracts.json` and their generated types are deleted; `npm run contract:generate` writes only
  `src/generated/api.d.ts`. Every command that used a fragment is typed from and validates against
  the published document.
- **`pidgen domain list` and `pidgen domain show` no longer fail with `UNEXPECTED_RESPONSE`.** A
  domain counts its people under `people` (`members`, `maintainers`) and its Epics under `epics`;
  `show` and every domain write answer the domain with `granted`, the people granted on it. A
  domain key the server refuses is its `DOMAIN_KEY_INVALID` (exit 2): the published request states
  the format in prose only, so the CLI no longer checks it first.
- **`pidgen contract list` and `pidgen contract show` no longer fail with `UNEXPECTED_RESPONSE`.**
  A contract's `provider` is `{project_id, kind, domain_id, key, name}` and its owner
  `owner_user_id`. A project's list is `{provides, builds_against}` (no `covered`); a domain's is
  `{own, coverage, builds_against}`. Linked work is `{work, hidden_count}`.
- **`pidgen contract revise` and `pidgen contract accept` answer the whole contract.** A revision
  requires `schema_format` and names its operations as `{name, types?}`; accept sends
  `POST /contracts/{contract_id}/revisions/{revision_number}/accept`. A revision that no longer
  waits is `CONTRACT_REVISION_NOT_WAITING` or `CONTRACT_REVISION_SUPERSEDED` (exit 5).
- **`pidgen ticket contract implements`, `builds-against` and `rm` answer the ticket's
  contracts** (`{contracts}`), each link with its `key`, `link`, `operations`, `criterion_id`,
  `linked_at` and `linked_by`.
- **`pidgen ticket create --domain` and `pidgen epic create --domain`** validate against the
  published `CreateTicketRequest`, which carries `domain_id`; `pidgen domain epics` validates
  against the published `DomainEpicBoard`.
- **The API coverage report** attributes the domain, contract, ticket contract and worker release
  routes to the commands that send them.

### Skills: `pidgen-manage-epics` and `pidgen-decompose-plan` file cross-project work under a Domain Epic

- **`pidgen-manage-epics`** files a Domain Epic: it finds the domain with `pidgen domain list`, checks the
  domain's Epics with `pidgen domain epics`, files it with
  `pidgen ticket create --kind epic --domain <domain>` (never `branch_mode` or `feature_branch`),
  and places each project's work under it by `parent_ticket_id`. It reads `PARENT_OUTSIDE_DOMAIN`
  (add the project with `pidgen domain project add`, or choose another domain),
  `DOMAIN_HAS_NO_PROJECTS`, `EPIC_FIELD_REFUSED` and the 403. Its single-project guidance is
  unchanged.
- **`pidgen-decompose-plan`**, "Work that spans Projects", files one cohort per project, each manifest's
  `epic_id` naming the same Domain Epic; finds the interface with `pidgen contract list` and
  `pidgen contract show`; and after each commit links the provider's delivery root with
  `pidgen ticket contract implements` and each consumer's root with
  `pidgen ticket contract builds-against`, naming its operations with `--operation`. Links never
  block or order work, and it reads the seven link refusals.
- **Neither skill creates or approves a contract:** when no contract fits, the work is filed and
  refinement defines the contract; linked work waits only when the Account's Contract approval
  setting asks for a person, who accepts with `pidgen contract accept`.
- **The skill lint checks it** (`tests/skills/lint.test.ts`).

### `pidgen ticket contract`: link work to a contract

- **New commands:** `pidgen ticket contract implements <ref> <contract> [--operation <op>]...` and
  `pidgen ticket contract builds-against <ref> <contract> [--operation <op>]...` link a ticket to a
  contract (`POST /api/v1/tickets/{ticket_id}/contracts`, `{contract_id, link, operations}`; no
  `--operation` sends `[]`, all of them); `data` is the link, with the criterion an implements link
  adds. `pidgen ticket contract rm <ref> <contract>` removes it
  (`DELETE /api/v1/tickets/{ticket_id}/contracts/{contract_id}`) and prints the removed link.
- **Only a delivery root implements, and a link never blocks:** it is not a dependency edge.
- **The seven link refusals** (`CONTRACT_LINK_NOT_DELIVERY_ROOT`, `CONTRACT_LINK_OUTSIDE_PROVIDER`,
  `CONTRACT_LINK_OWN_PROVIDER`, `CONTRACT_LINK_INSIDE_COHORT`, `CONTRACT_DEPRECATED`,
  `CONTRACT_RETIRED`, `CONTRACT_UNKNOWN_OPERATION`) exit 5 whatever their status.
- **The link routes join the pending fragment** `contracts/pending/contracts.json`.

### `pidgen contract`: list, show, revise and accept

- **New commands:** `pidgen contract list (--project <project> | --domain <domain>)` reads a
  project's or a domain's contracts (`GET /api/v1/projects/{project_ref}/contracts`,
  `GET /api/v1/domains/{domain_id}/contracts`); `pidgen contract show <contract>` reads one with its
  revisions, how each was accepted, and the work implementing and building against it, hidden work
  as counts (`GET /api/v1/contracts/{contract_id}`).
- **`pidgen contract revise <contract> -f <file> [--markdown <file.md>]`** sends a new revision
  (`POST /api/v1/contracts/{contract_id}/revisions`), validated before it is sent; `data` is the
  revision, with `acceptance` `automatic` or `waiting`.
- **`pidgen contract accept <contract> [--revision n]`** accepts the named revision, or the one
  waiting revision (`POST /api/v1/contracts/{contract_id}/revisions/{number}/accept`); none waiting
  exits 5 with `NO_REVISION_WAITING` and sends no accept; a 403 exits 3. There is no create
  command: contracts are defined when work is refined.
- **Built against a pending fragment**, `contracts/pending/contracts.json` (types in
  `src/generated/contracts.d.ts`).

### Domain Epics: `pidgen ticket create --domain` and `pidgen domain epics`

- **`--domain <domain>`** on `pidgen ticket create` and `pidgen epic create` files a Domain Epic:
  an Epic that holds work from several of a domain's projects, filed in the domain's home and
  owning no branch. The body is sent to `POST /api/v1/tickets` with `kind: epic` and `domain_id`
  instead of `project_id`; `--kind story` or `task`, or a file naming `project_id`, `branch_mode` or
  `feature_branch`, exits 2 with `INPUT_INVALID` and sends nothing. Without `--domain` nothing
  changes.
- **New command:** `pidgen domain epics <domain> [--state open|finished] [--page n] [--per-page n]
  [--no-subdomains]` reads a domain's Epics with their work grouped by project and the count of
  work you cannot see (`GET /api/v1/domains/{domain_id}/epics`).
- **Built against a pending fragment**, `contracts/pending/domain-epics.json` (types in
  `src/generated/domain-epics.d.ts`): the published create plus `domain_id`, and the Epics read.
- **Refusals:** `DOMAIN_HAS_NO_PROJECTS` exits 5; `DOMAIN_PROJECT_CONFLICT` and
  `EPIC_FIELD_REFUSED` exit 2; `DOMAIN_NOT_FOUND` exits 4; a 403 exits 3.

### `pidgen domain`: domains, their projects, parents, members and maintainers

- **New commands:** `pidgen domain list|show|create|edit|archive|unarchive`,
  `pidgen domain project add|rm`, `pidgen domain parent add|rm`, `pidgen domain member add|rm` and
  `pidgen domain maintainer add|rm`, calling the App Service's stated domain routes
  (`/api/v1/domains`). `maintainer rm` keeps the person as a member; `member rm` removes them.
- **Built against a pending fragment**, `contracts/pending/domains.json`, until the server
  publishes the routes: its types are generated by `npm run contract:generate` into
  `src/generated/domains.d.ts`, request bodies and every answer are validated against it, and an
  answer that does not match exits 1 with `UNEXPECTED_RESPONSE`.
- **Refusals:** `DOMAIN_CYCLE`, `DOMAIN_TOO_DEEP`, `DOMAIN_IS_ACCOUNT_ROOT`,
  `DOMAIN_COVERAGE_IN_USE` and `DOMAIN_HAS_OPEN_EPICS` exit 5 whatever their HTTP status, with the
  server's details; `DOMAIN_NOT_FOUND` and `MEMBER_NOT_FOUND` exit 4; a duplicate key (409) exits
  5; the switched-off domains feature (403) exits 3.

### The worker installs from the series the server names, verified, with `--test` for rehearsals

- **The server names a series, the index supplies the release.** `GET /api/v1/workers/releases`
  now lists one series per accepted worker protocol (`current`, `supported`), each with its
  requirement `pidgen-worker~=X.Y.0` and image tag, and no files or digests. `pidgen worker
  install`, `update`, `enroll` and `setup` take the newest release of the series from PyPI and the
  CPython 3.12 wheel for this machine (Linux x86_64 or aarch64, macOS arm64 or x86_64), verify its
  PEP 740 attestation, and run `uv tool install --python 3.12` on the verified file.
- **`--test`** on `worker install`, `worker update` and `setup` installs a release rehearsal
  (`X.Y.Z.devN`) from TestPyPI, verified against the same publisher. The install record names
  `index: testpypi`.
- **Releases are verified against Pidgen's release publisher**, an identity the CLI carries; the
  server names only the series.
- **The container form** resolves the image tag the server names to its digest with
  `docker buildx imagetools inspect`, then verifies the cosign signature over that digest before
  pulling it.
- `--version` takes a release of any series the server accepts; one of another series exits 5
  with `RELEASE_UNSUPPORTED`, and `error.details.accepted` lists the accepted series.

The first public release of `pidgen`, the command-line client for Pidgen. It supports App Service
API version 1.0 and uses the App Service's published public API document, committed as
`contracts/openapi.json`, plus the agreed pending worker-release and domain contracts.

### Commands

- **Sign in and choose an Account:** `pidgen auth login|logout|status|list|revoke` with device-code
  login or a Personal API Token, and `pidgen account list|use`. The server is `PIDGEN_API_URL`,
  else the profile's, else the hosted server, `https://api.pidgen.ai`, so `pidgen auth login` needs
  no URL on a fresh machine. A command that needs a credential and has none exits 3 with
  `AUTH_REQUIRED` before sending anything.
- **Read and file work:** `pidgen project`, `pidgen ticket list|show|create|edit|template|types`,
  owners and followers, dependencies (`pidgen ticket dep add|rm|list`) and epic placement, plus
  `pidgen epic` as aliases for epic-kind tickets with their dependency graph, `pidgen intent` for
  durable intake requests, and
  `pidgen manifest template|apply` to file a ticket with its children and edges in one previewed
  commit.
- **Plan:** `pidgen plan show|apply|promote|template`, child-plan briefs, and `pidgen plan cohorts`
  to group slices that touch the same files.
- **Act on tickets and runs:** `pidgen ticket actions` lists what a ticket, its runs and its
  dependencies allow; `pidgen ticket act` previews and executes any of them, and
  `pidgen ticket retry`, `pidgen ticket replay`, `pidgen ticket reopen`, `pidgen ticket cancel` and
  `pidgen ticket clarify` cover the common ones. `pidgen run list|show|node-output` reads runs, and
  `pidgen review list|attention` lists what needs a person.
- **Steer running agents:** `pidgen session steer` sends live or queued instructions with
  attachments and quotes, and `pidgen session instructions|edit-instruction|withdraw-instruction`
  and `pidgen ticket instructions` follow them.
- **Set up a worker:** `pidgen setup` guides a fresh machine through checks, sign-in, verified
  installation, enrollment, startup and connection verification. It resumes completed steps and
  prints the equivalent scriptable commands; without a terminal it exits 2 with
  `TERMINAL_REQUIRED`.
- **Check and install a worker:** `pidgen doctor` checks the machine and its connection;
  `pidgen worker install|verify` installs and verifies a wheel or container using signed
  provenance, against the release the server names (`GET /api/v1/workers/releases`). Enrollment
  uses the same verified install before creating an enrollment.
- **Run a worker:** `pidgen worker enroll|start|stop|status|doctor` enrolls this machine and runs
  the separately distributed `pidgen-worker`, and `pidgen worker subscriptions` shows and switches
  its provider subscriptions.
- **Update and remove a worker:** `pidgen worker update` installs a verified release and can
  restart the worker, rolling back if startup fails; `pidgen worker uninstall` removes it,
  preserving the worker home unless `--purge` is given. `pidgen worker status` reports available
  updates; nothing updates automatically.
- **Skills, feedback and the escape hatch:** `pidgen skills install|status`, `pidgen feedback`,
  and `pidgen api get|post|put|patch|delete` for any published operation, validated against the
  document.

### Conventions

- On a terminal, commands print human-readable output; otherwise, and with `--format json`, they
  print exactly one JSON envelope on standard output. Exit codes are stable, 0 to 8.
- `pidgen setup` is the only interactive command. Every other command, including
  `pidgen worker enroll`, never prompts; enrollment uses `--install` or `--no-install`.
- Anything with side effects previews first and applies only with `--apply`, the preview's
  `--digest` and explicit `--ack` codes.
- Configuration lives in `~/.config/pidgen/config.json`, environment variables are `PIDGEN_*`, and
  the CLI sends `PIDGEN-API-Version` on every request. Tokens carry the `pidgen_cli_` and
  `pidgen_pat_` prefixes the server issues; `awes_cli_` and `awes_pat_` tokens issued before still
  work.

### Skills

Ten agent skills ship in the package and call only public `pidgen` commands:
`pidgen-file-ticket`, `pidgen-decompose-plan`, `pidgen-manage-epics`, `pidgen-manage-contracts`,
`pidgen-triage-requests`, `pidgen-query-tickets`, `pidgen-retry-run`, `pidgen-replay-node`,
`pidgen-unstick-ticket` and `pidgen-setup-worker`. Their names carry the `pidgen-` prefix so they do
not collide with other skills in a shared skills directory. `pidgen-setup-worker` takes a machine
from nothing to a running, verified worker with the scriptable commands `pidgen setup` lists when
there is no terminal, then configures the worker (pool sizes, session caps per coding agent,
fallback provider logins and the primary one); for that local configuration alone it also runs the installed worker's own
`pidgen-worker capacity` and `pidgen-worker subscriptions` commands.

### Planned

- `pidgen session steer --upload` and `pidgen ticket list --epic`, which wait on the public API.
- The container runtime in `pidgen setup`; the wheel runtime is the guided path today.
- Revoking the credential on the server in `pidgen auth logout`; it forgets it locally today.
