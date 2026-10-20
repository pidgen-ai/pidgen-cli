# Contributing

`pidgen` is open source under Apache-2.0. This page is for people changing the CLI itself. The user
documentation is in [`docs/`](docs/README.md), and the rules every change must follow — public
material only, the public API only, and the CLI contract — are in [`AGENTS.md`](AGENTS.md).

## Stack

| Concern | Choice |
|---|---|
| Language and runtime | TypeScript 5.9, Node.js ≥ 22.12 (Node 20 is end-of-life; `commander` 15 and `vitest` 5 need 22.12), ES modules only |
| Command parsing | `commander` |
| Request validation | `zod`, from the public API schemas (`z.fromJSONSchema`) |
| Input files | `yaml`, so `-f` bodies can be YAML as well as JSON; it has no dependencies of its own |
| Worker provenance | The verifying parts of the `sigstore` library (the one npm uses for package provenance): `@sigstore/verify` checks a Sigstore bundle, `@sigstore/bundle` reads one, `@sigstore/protobuf-specs` reads the trust root, and `@sigstore/tuf` fetches Sigstore's trust root. They verify the worker's PEP 740 attestation against its release identity, which is not code to write by hand. The signing half (`@sigstore/sign`) is not a dependency, and all four load only when a worker artifact is verified, so other commands start no slower |
| Setup's prompts | `@clack/prompts` 1.8.1 and the `@clack/core` 1.5.1 it is built on (MIT; their own dependencies are `sisteransi`, `fast-wrap-ansi` and `fast-string-width`), pinned exactly: checkbox, select, text and confirm prompts, spinners and task logs for `pidgen setup`, the one interactive command. `@clack/core` draws setup's own screens (each answered question collapses to one line); `@clack/prompts` gives the spinner and task log. Only setup loads them, with a dynamic import, so no other command starts slower |
| API types | `openapi-typescript`, generated from `contracts/openapi.json` |
| Build | `tsup`, one bundled file for the `pidgen` bin |
| Tests | `vitest`; `@stoplight/prism-cli` as a mock server for contract tests |

Keep runtime dependencies to a minimum; every one slows `npx pidgen` and widens the supply chain.
Adding one needs a reason in the pull request.

## Repository layout

```text
src/
  bin/pidgen.ts          entry point: builds the real context and runs the CLI
  cli.ts                 parse, dispatch, select presentation, return the exit code
  commands/index.ts      every implemented command (the registry the skill lint reads)
  commands/<noun>/*.ts   one module per command: flags, the route(s) it calls, its data
  core/
    context.ts           RunContext: environment, I/O, standard input, fetch, clock (faked in tests)
    config.ts            profiles, credentials file, environment overrides
    input.ts             -f bodies: read a file or standard input, parse JSON/YAML, validate
    http.ts              the API client: base URL, credential, PIDGEN-API-Version, retries, errors
    session.ts           the client for the selected profile and Account; envelope meta from a response
    server.ts            confirms a server is Pidgen and accepts this CLI's API version
    envelope.ts          the stable JSON output envelope and human rendering entry point
    errors.ts            CliError, HTTP status → exit code and error.code
    exit-codes.ts        the exit code table
    preview.ts           the preview/apply engine: digests, acknowledgements, idempotency, --wait
    registry.ts          the CommandSpec shape and noun descriptions
    skills.ts            installing, stamping, and classifying bundled skills
    worker.ts            find, run, and manage the separately installed pidgen-worker
    worker-install.ts    the runtime adapter interface, the wheel adapter, the install record, and running uv
    worker-container.ts  the container adapter: cosign-verified image pulled by digest, run with docker
    worker-releases.ts   read and validate GET /workers/releases and pick a release
    domains.ts           the domain routes: send, validate the body and the answer
    domain-epics.ts      the domain Epics read and what a Domain Epic's file may not name
    contracts.ts         the contract and ticket contract routes: send, validate the body and the answer
    doctor.ts            the check shape doctor and worker verify share; the release-list checks
    provenance.ts        verify a worker wheel's PEP 740 attestation and image's cosign signature
    worker-release-identities.ts  the publisher identities worker releases must be signed by
    version.ts           CLI version and the API version it speaks
  generated/api.d.ts     types generated from contracts/openapi.json — never edited by hand
contracts/openapi.json   committed copy of the App Service's public API document
contracts/pending/       agreed routes the server has not published yet (one fragment per feature)
scripts/                 contract pull and check, release check
skills/<name>/SKILL.md   bundled agent skills
docs/                    user documentation
tests/                   unit, command, and skill-lint tests (tests/skills/imported.json lists exemptions)
tests/contract/          contract tests against a Prism mock server (npm run test:contract)
tests/support/           test helpers, including mock-server.ts, which runs Prism
tests/fixtures/          openapi.fixture.json, for contract tests that need response examples
```

Keep one module per command under `src/commands/<noun>/`, listed in `src/commands/index.ts`. A
command is added to the registry only when the public API route it calls is in the committed
document; until then it stays *planned* in [Commands](docs/commands.md), so skills cannot reference
it.

## Scripts

| Script | Does |
|---|---|
| `npm run build` | Bundle to `dist/pidgen.js` |
| `npm test` | Unit, command, and skill-lint tests |
| `npm run test:tmp-check` | `npm test` with a private temporary directory; fails if the run leaves anything in it (CI runs this) |
| `npm run test:contract` | Contract tests against a Prism mock server (kept out of `npm test`) |
| `npm run lint` | ESLint and Prettier check |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run contract:pull -- --url <server>` | Fetch the public API document, refusing one that cites internal records |
| `npm run contract:generate` | Regenerate `src/generated/api.d.ts` and each pending fragment's types |
| `npm run release:check` | Refuse a release while any skill is still imported |
| `npm run api:coverage [-- --out <file>]` | Print every published operation and the command that calls it, for API audits |

Run `npm test`, `npm run lint`, and `npm run typecheck` before proposing a change.

## Tests

- **Unit tests** cover each command's argument handling, request construction, envelope, and exit
  code, with the HTTP layer faked.
- **Contract tests** (`tests/contract/`, run with `npm run test:contract`) drive the real HTTP client
  against a Prism mock server. `tests/support/mock-server.ts` starts `prism mock` on a free loopback
  port for a given OpenAPI document and stops it after the suite's tests (`useMockServer`). By
  default it serves the committed `contracts/openapi.json`, and the tests run `pidgen api` and the
  preview/apply engine against its published routes. Prism generates responses from the document's
  schemas, so these tests check shapes and status mapping, not values. Error responses are
  selected with Prism's `__code` query parameter. `tests/fixtures/openapi.fixture.json`, a small
  representative API with response examples, is used only where a test needs what the committed
  document lacks: a specific error code, or an apply that settles only after polling its status
  route. CI runs the contract tests on Linux and macOS, and fails when `src/generated/api.d.ts` is
  stale.
- **Skill lint** (`tests/skills/lint.test.ts`) checks every `skills/*/SKILL.md`
  ([Rules for skill content](#rules-for-skill-content)).
- **Provenance** (`tests/core/provenance.test.ts`) verifies recorded fixtures in
  `tests/fixtures/provenance/`: a test Sigstore trust root, a fixture wheel, its PEP 740 attestation
  signed by a test identity, one signed by an impostor, and a recorded `cosign verify` output. The
  verifier takes its trust root and accepted identities through `ProvenanceTrust`, and cosign
  through `CosignRunner`, so the tests inject them and never reach PyPI, GHCR or Sigstore.
  `node scripts/provenance-fixtures.mjs` regenerates the fixtures with throwaway keys; run it only
  to change them, and update the digests the test pins.
- **Worker install** (`tests/commands/worker-install.test.ts`, `tests/commands/doctor.test.ts`)
  uses `tests/support/worker-install.ts`: the release list is shaped by the published
  `WorkerReleaseList` (its licence is `WORKER_EULA` in `tests/support/published.ts`), PyPI
  answers with the provenance fixtures, the trust root and identity are the test ones (injected
  through `RunContext.provenanceTrust`), and a fake `uv` on `PATH` logs the argument lists it was
  run with. `tests/contract/worker-releases.test.ts` runs the same commands against Prism serving
  the committed document, with that release list as the route's example
  (`committedDocumentForStaticMock` in `tests/support/mock-server.ts`).
- **Container runtime** (`tests/commands/worker-container.test.ts`) uses
  `tests/support/worker-container.ts`: a fake `docker` (`RunContext.docker`) that keeps images,
  volumes and containers in memory and answers `docker inspect` in the recorded shape of
  `tests/fixtures/container/docker-inspect.json`, and a fake `cosign` (`RunContext.cosign`) that
  answers with the recorded `cosign verify` output, or the recorded wrong-identity and unsigned
  errors (`tests/fixtures/provenance/*.stderr`). Both log every argument list to one shared log,
  so a test sees what ran and in which order. No test reaches a registry or a Docker daemon; a
  test context's `docker` and `cosign` reject any call.
- Every command gets tests for success, one server refusal, and its usage errors, and checks the
  envelope and exit code.
- **Temporary directories**: a test makes them with `tempDir()` or `tempDirSync()`
  (`tests/support/temp.ts`, also exported by `tests/support/context.ts`), never with `mkdtemp`
  directly. Each one is recorded, and `tests/support/setup.ts` (`setupFiles` in both vitest
  configs) removes them all (`rm -r`, force) when the test file finishes;
  `tests/support/global-setup.ts` removes the directory vitest itself makes in the temporary
  directory for each run. Set `PIDGEN_KEEP_TEST_DIRS=1` to keep them for debugging, for example
  `PIDGEN_KEEP_TEST_DIRS=1 npx vitest run tests/commands/worker.test.ts`; the kept paths are
  printed when each file finishes. `npm run test:tmp-check` (`scripts/test-tmp-check.mjs`) runs
  the tests with `TMPDIR` set to an empty private directory and fails if anything is left in it
  (Node's shared `node-compile-cache` is not counted). `tests/support/temp.test.ts` proves the
  cleanup and the keep switch on a fixture test file.

Tests never call a real Pidgen server and never contain real credentials, hostnames, or Account ids.

## Output presentation

Terminal stdout defaults to human-readable output; nonterminal stdout defaults to JSON.
`--format json` and `--format table` override this for execution and parser errors. Keep JSON
envelopes, payloads, metadata and exit codes unchanged. Keep stderr progress and setup interactivity
independent of stdout's terminal state. Help/version print text; foreground `worker start` inherits
the worker's streams and status ([Output and exit codes](docs/output-and-exit-codes.md)).

`src/core/human.ts` receives command identity and stdout terminal state/width outside the envelope.
Extend its presentation dispatch for command-specific output; never add presentation fields to data
or metadata. Test format selection with stdout and stderr terminal states independently. Bundled
skills must explicitly select `--format json` whenever they read structured responses.

### Presentation inventory

[Presentation inventory](#presentation-inventory) covers every registered operation, including
expanded `api` verbs. `tests/cli.test.ts` compares exact names with `commands` from
`src/commands/index.ts`, rejects duplicates and checks the categories. Add or update the row when
changing the command surface. Shared error rendering retains code, message, diagnostics, fixes,
blocking findings and scriptable actions; mutation failures retain their preview requirements.

`resource-human.ts` owns resource lists, details and text; `mutation-human.ts` owns application
states and templates; `lifecycle-human.ts` owns auth, Account, worker, setup and diagnostic details.
`human.ts` owns skill installation and the complete fallback. These renderers receive context
outside the JSON envelope. Narrow widths wrap prose while retaining actionable values.

Help (`--help`, including noun/group help), no-argument help and CLI version (`--version`, `-V`)
are parser exceptions: they print text regardless of format and do not execute an operation.
Foreground worker execution is a subprocess handoff. Setup summaries and questions, authentication
verification instructions, installation commands, verification progress, enrollment output and
rollback progress retain their established stderr streams. Changing presentation must not add
prompts, capture foreground streams, or infer success from an unknown outcome or skipped check.

<!-- presentation-inventory:start -->

| Operation | Category | Presentation and exceptions |
| --- | --- | --- |
| `account list` | list | Complete credential or Account records, including selected and unknown state. |
| `account use` | mutation | Labeled lifecycle details; all supplied qualifications retained. |
| `api delete` | mutation | Preview requirements, actual application state and complete result details. |
| `api get` | detail | API response; resource sections with compact collections where appropriate. |
| `api patch` | mutation | Preview requirements, actual application state and complete result details. |
| `api post` | mutation | Preview requirements, actual application state and complete result details. |
| `api put` | mutation | Preview requirements, actual application state and complete result details. |
| `auth list` | list | Complete credential or Account records, including selected and unknown state. |
| `auth login` | mutation | Login result on stdout; verification address/code and established waiting progress stay on stderr. |
| `auth logout` | mutation | Labeled lifecycle details; all supplied qualifications retained. |
| `auth revoke` | mutation | Labeled lifecycle details; all supplied qualifications retained. |
| `auth status` | status | Labeled lifecycle details; all supplied qualifications retained. |
| `contract accept` | mutation | Preview requirements, actual application state and complete result details. |
| `contract create` | mutation | Preview requirements, actual application state and complete result details. |
| `contract list` | list | Contracts; resource sections with compact collections where appropriate. |
| `contract propose` | mutation | Preview requirements, actual application state and complete result details. |
| `contract publish` | mutation | Preview requirements, actual application state and complete result details. |
| `contract revise` | mutation | Preview requirements, actual application state and complete result details. |
| `contract show` | detail | Contract; resource sections with compact collections where appropriate. |
| `doctor` | diagnostic | Complete checks, statuses, fixes and supporting records, on success or failure. |
| `domain archive` | mutation | Preview requirements, actual application state and complete result details. |
| `domain create` | mutation | Preview requirements, actual application state and complete result details. |
| `domain edit` | mutation | Preview requirements, actual application state and complete result details. |
| `domain epics` | list | Domain Epics; resource sections with compact collections where appropriate. |
| `domain list` | list | Domains; resource sections with compact collections where appropriate. |
| `domain maintainer add` | mutation | Preview requirements, actual application state and complete result details. |
| `domain maintainer rm` | mutation | Preview requirements, actual application state and complete result details. |
| `domain member add` | mutation | Preview requirements, actual application state and complete result details. |
| `domain member rm` | mutation | Preview requirements, actual application state and complete result details. |
| `domain parent add` | mutation | Preview requirements, actual application state and complete result details. |
| `domain parent rm` | mutation | Preview requirements, actual application state and complete result details. |
| `domain project add` | mutation | Preview requirements, actual application state and complete result details. |
| `domain project rm` | mutation | Preview requirements, actual application state and complete result details. |
| `domain show` | detail | Domain; resource sections with compact collections where appropriate. |
| `domain unarchive` | mutation | Preview requirements, actual application state and complete result details. |
| `epic create` | mutation | Preview requirements, actual application state and complete result details. |
| `epic dag show` | detail | Epic dependency graph; resource sections with compact collections where appropriate. |
| `epic edge add` | mutation | Preview requirements, actual application state and complete result details. |
| `epic edge rm` | mutation | Preview requirements, actual application state and complete result details. |
| `epic edit` | mutation | Preview requirements, actual application state and complete result details. |
| `epic list` | list | Epics; resource sections with compact collections where appropriate. |
| `epic show` | detail | Epic; resource sections with compact collections where appropriate. |
| `feedback` | mutation | Preview requirements, actual application state and complete result details. |
| `intent list` | list | Intents; resource sections with compact collections where appropriate. |
| `intent respond` | mutation | Preview requirements, actual application state and complete result details. |
| `intent show` | detail | Intent; resource sections with compact collections where appropriate. |
| `intent submit` | mutation | Preview requirements, actual application state and complete result details. |
| `intent withdraw` | mutation | Preview requirements, actual application state and complete result details. |
| `manifest apply` | mutation | Preview requirements, actual application state and complete result details. |
| `manifest template` | text | Copyable template text and labeled fields. |
| `plan apply` | mutation | Preview requirements, actual application state and complete result details. |
| `plan cohorts` | list | Cohort plan; resource sections with compact collections where appropriate. |
| `plan promote` | mutation | Preview requirements, actual application state and complete result details. |
| `plan show` | detail | Child plan; resource sections with compact collections where appropriate. |
| `plan template` | text | Copyable template text and labeled fields. |
| `project doctor` | status | The frame's title, one line per group with the failures beneath by Ticket key, then the verdict line, its sentence and the fix; the same on failure when the setup is the problem. |
| `project inspect` | detail | One row per area with its state word and summary, then each open question with its evidence and `--answer`. |
| `project list` | list | Projects; resource sections with compact collections where appropriate. |
| `project rehearse` | status | Each step on stdout as it is reported (stderr under JSON on a terminal), the verdict last; a failed rehearsal's verdict on failure. |
| `project setup` | mutation | The proposed files; with `--write` each file's status under `.pidgen/`; with `--pull-request` the pull request. |
| `project show` | detail | Project; resource sections with compact collections where appropriate. |
| `request accept` | mutation | Preview requirements, actual application state and complete result details. |
| `request acknowledge` | mutation | Preview requirements, actual application state and complete result details. |
| `request close` | mutation | Preview requirements, actual application state and complete result details. |
| `request list` | list | Requests; resource sections with compact collections where appropriate. |
| `request promote` | mutation | Preview requirements, actual application state and complete result details. |
| `request reply` | mutation | Preview requirements, actual application state and complete result details. |
| `request show` | detail | Request; resource sections with compact collections where appropriate. |
| `request submit` | mutation | Preview requirements, actual application state and complete result details. |
| `review attention` | list | Attention queue; resource sections with compact collections where appropriate. |
| `review list` | list | Review tickets; resource sections with compact collections where appropriate. |
| `run list` | list | Runs; resource sections with compact collections where appropriate. |
| `run node-output` | text | Node output; resource sections with compact collections where appropriate. |
| `run show` | detail | Run; resource sections with compact collections where appropriate. |
| `session edit-instruction` | mutation | Preview requirements, actual application state and complete result details. |
| `session instructions` | list | Session instructions; resource sections with compact collections where appropriate. |
| `session steer` | mutation | Preview requirements, actual application state and complete result details. |
| `session withdraw-instruction` | mutation | Preview requirements, actual application state and complete result details. |
| `setup` | exception | Interactive steps and commands stay on stderr; stdout shows complete step results or failure recovery. |
| `skills install` | installation | Distinct skills, destinations, agents, record counts and all installation outcomes. |
| `skills status` | status | Labeled lifecycle details; all supplied qualifications retained. |
| `ticket act` | mutation | Preview requirements, actual application state and complete result details. |
| `ticket actions` | list | Ticket actions; resource sections with compact collections where appropriate. |
| `ticket cancel` | mutation | Preview requirements, actual application state and complete result details. |
| `ticket clarify` | mutation | Preview requirements, actual application state and complete result details. |
| `ticket contract builds-against` | mutation | Preview requirements, actual application state and complete result details. |
| `ticket contract implements` | mutation | Preview requirements, actual application state and complete result details. |
| `ticket contract rm` | mutation | Preview requirements, actual application state and complete result details. |
| `ticket create` | mutation | Preview requirements, actual application state and complete result details. |
| `ticket dep add` | mutation | Preview requirements, actual application state and complete result details. |
| `ticket dep list` | list | Ticket dependencies; resource sections with compact collections where appropriate. |
| `ticket dep rm` | mutation | Preview requirements, actual application state and complete result details. |
| `ticket edit` | mutation | Preview requirements, actual application state and complete result details. |
| `ticket follow` | mutation | Preview requirements, actual application state and complete result details. |
| `ticket history` | list | Ticket history; resource sections with compact collections where appropriate. |
| `ticket instructions` | list | Ticket instructions; resource sections with compact collections where appropriate. |
| `ticket list` | list | Tickets; resource sections with compact collections where appropriate. |
| `ticket move` | mutation | Preview requirements, actual application state and complete result details. |
| `ticket owner` | mutation | Preview requirements, actual application state and complete result details. |
| `ticket reopen` | mutation | Preview requirements, actual application state and complete result details. |
| `ticket replay` | mutation | Preview requirements, actual application state and complete result details. |
| `ticket retry` | mutation | Preview requirements, actual application state and complete result details. |
| `ticket show` | detail | Ticket; resource sections with compact collections where appropriate. |
| `ticket template` | text | Copyable template text and labeled fields. |
| `ticket types` | list | Workflow types; resource sections with compact collections where appropriate. |
| `ticket unfollow` | mutation | Preview requirements, actual application state and complete result details. |
| `worker doctor` | diagnostic | Complete checks, statuses, fixes and supporting records, on success or failure. |
| `worker login` | mutation | Labeled lifecycle details: the harness and its login state. |
| `worker enroll` | mutation | Labeled lifecycle details; all supplied qualifications retained. |
| `worker install` | installation | Labeled lifecycle details; all supplied qualifications retained. |
| `worker start` | exception | Foreground inherits worker streams/status with no CLI result; --detach renders lifecycle details. |
| `worker status` | status | Labeled lifecycle details; all supplied qualifications retained. |
| `worker stop` | mutation | Labeled lifecycle details; all supplied qualifications retained. |
| `worker restart` | mutation | Labeled lifecycle details with the new pid or container name in the heading; all supplied qualifications retained. |
| `worker subscriptions use` | mutation | Labeled lifecycle details; all supplied qualifications retained. |
| `worker subscriptions` | status | Labeled lifecycle details; all supplied qualifications retained. |
| `worker uninstall` | mutation | Labeled lifecycle details; all supplied qualifications retained. |
| `worker update` | installation | Labeled lifecycle details; all supplied qualifications retained. |
| `worker verify` | diagnostic | Complete checks, statuses, fixes and supporting records, on success or failure. |

<!-- presentation-inventory:end -->

## The API contract

The CLI calls only routes in the App Service's public API document, committed as
`contracts/openapi.json` ([API compatibility](docs/api-compatibility.md)). `src/generated/api.d.ts`
is generated from it and never edited by hand.

### Updating the contract

1. `npm run contract:pull -- --url <server>` fetches the document into `contracts/openapi.json`.
2. `npm run contract:generate` regenerates the types.
3. Review the diff: a removed or changed route, field or error code is a breaking change for the
   CLI too. A pull must not silently remove a supported CLI input: withdraw it in the same change,
   with its docs and a changelog entry.
4. Commit the document and the generated file together.

`contract:pull` names the server it fetched from only on standard output; the document it writes
carries no server address. Never commit that address — a hostname or port — to source, tests or
docs; examples use `https://pidgen.example.com`.

CI regenerates the types and fails when `src/generated/api.d.ts` does not match the committed
document. The document keeps the pull's JSON layout (two-space indentation), so
`contracts/openapi.json` is excluded from Prettier.
Generation reads only `contracts/openapi.json` and does not perform a pull.

### The document is the server's

`contracts/openapi.json` is the server's published document and nothing else: no route or field is
added ahead of a server release, and the file is never edited by hand. When a command needs
something the server does not publish, record the missing route
under [Not yet published](docs/api-compatibility.md#not-yet-published) and mark the command or flag
*planned*; do not work around it.

### Pending fragments

A route the App Service has agreed but not yet published may stand in as a **pending fragment**
until it is published: an OpenAPI document under `contracts/pending/` holding only those routes and
the schemas they use, with a response example for each. It is treated like the document: its types are
generated by `npm run contract:generate` into `src/generated/`, the command validates every
response against it, and its contract tests run against Prism serving the fragment. It is never
merged into `contracts/openapi.json`. When the server publishes the route, pull the document as
usual, switch the command to the published types, and delete the fragment and its generated file
in the same change; `tests/scripts/contract-generate.test.ts` fails once the published document
has one of its routes, as a reminder. Each fragment is listed with its routes in that test's
`PENDING_ROUTES`, the published schemas it copies in `COPIED_SCHEMAS`, a published route it holds
with a field added in `EXTENDED_ROUTES` and that field in `EXTENDED_SCHEMAS` (the schema keeps its
published name and is otherwise the published one), and its `openapi-typescript` line is in
`contract:generate`. There are two today. `contracts/pending/worker-enrollments.json`: `install_id`
on `POST /api/v1/workers/enrollments` and `GET /api/v1/workers`, and
`GET /api/v1/workers/enrollments` and `DELETE /api/v1/workers/enrollments/{enrollment_id}`, typed
in `src/generated/worker-enrollments.d.ts` and used through `src/core/worker-enrollments.ts`.
`contracts/pending/project-readiness.json`: the five routes under
`/api/v1/projects/{project_ref}/readiness` (the readiness, the proposal archive, the setup pull
request, the answers and the rehearsal), typed in `src/generated/project-readiness.d.ts` and used
through `src/core/readiness.ts`; its fixtures are under `tests/fixtures/readiness/`. The
worker release, domain, Domain Epic, contract, contract creation, contract publishing and Request
fragments were deleted when the server published their routes, and that test's
`RETIRED_FRAGMENTS` checks nothing names them again.

The published document states those routes with schemas and no response examples. Their command
tests answer with fixtures typed from the generated types and checked against the published
schemas (`tests/support/published.ts`), and their contract tests run against Prism generating
answers from the schemas. Prism's static mock answers a property with its `default`, and the
published Ticket schemas declare `title` and `objective` with `default: ""` under `minLength: 1`,
so a contract test whose command validates a Ticket serves `committedDocumentForStaticMock()`
(`tests/support/mock-server.ts`), which drops such defaults and can attach an example to a route.

A pull therefore replaces the document wholesale. Review its diff for the operations and schemas
the commands use: `tests/scripts/contract-generate.test.ts` fails when an operation a command sends
or a schema name a command types itself with is missing, and the Prism suites under
`tests/contract/` exercise the commands against the new document. Behaviour the document used to
enforce and the server now checks at run time (an answer naming its question, a plan answer with
exactly one of its two fields) is checked by the command before sending, so the user still gets
`INPUT_INVALID` and nothing is sent.

### Refusing internal citations

The committed document is public, so `npm run contract:pull` checks the fetched document before it
writes anything. It walks every string in the document — values and member names — and refuses the
document when any of them cites an internal record:

| Refused | Pattern |
|---|---|
| ADR citation | `ADR-\d+` |
| PRD citation | `PRD` as a word |
| Section mark | `§` |
| Slice id | `\d{3}/S\d+` |
| Decision citation | `Decision \d+` |
| Source path | a path ending in `.py` |

A refused pull exits 1, lists every match on standard error as the JSON pointer of the string that
contains it and the matched text (for example `/paths/~1api~1v1~1tickets/get/description:
"ADR-7" (ADR citation)`), and leaves `contracts/openapi.json` unchanged. Fix the document on the
server and pull again; there is no override. Ticket keys given as examples, such as `e.g. PIDGEN-12`,
are allowed. A clean document is written and the number of paths it contains is reported, after
[retired operations](#retired-operations) are left out.

### Retired operations

Some operations the App Service has retired are still in the document it publishes. A pull leaves
them out before the citation check, with each component schema that only they used, and names on
standard output what it left out, so the CLI treats them as removed without waiting for the server
release that stops publishing them. Schemas nothing referred to in the server's document are kept.
They are listed in `RETIRED_OPERATIONS` in `scripts/contract-check.mjs`; today these are the legacy
Epic routes (Epics are Tickets): `GET`/`POST /api/v1/epics`, `GET`/`PATCH /api/v1/epics/{epic_id}`,
`GET /api/v1/epics/{epic_id}/dag`, `POST`/`DELETE /api/v1/epics/{epic_id}/dag/edges` and
`POST /api/v1/tickets/{ticket_id}/epic`. The Domain and Project Epic reads
(`GET /api/v1/domains/{domain_id}/epics`, `GET /api/v1/projects/{project_id}/epics`) are current and
kept. An entry can go once no server the CLI supports publishes the operation.

The checks live in `scripts/contract-check.mjs` (`findCitations`, `pruneRetired` and
`pullContract`) and are tested in `tests/scripts/contract-pull.test.ts`.

### Testing against the contract

- **Here:** contract tests (`npm run test:contract`, run in CI) drive the CLI's HTTP client and
  `pidgen api` against a mock server that `@stoplight/prism-cli` builds from the committed
  `contracts/openapi.json`, so a route or schema the CLI relies on that disappears from the
  document fails them. The committed document carries no response examples, so a small fixture
  document (`tests/fixtures/openapi.fixture.json`) covers only what it cannot mock: a specific
  error code, and an apply that settles after polling. Routes published before their commands
  exist are still covered: for example `tests/contract/me-and-cancellation.test.ts` drives
  `GET /me`, `GET /me/sessions`, `DELETE /me/sessions/{session_id}` and the ticket cancellation
  pair through `pidgen api`, the HTTP client and the preview/apply engine. Refusals the committed
  document does not exemplify run against Prism serving a copy of it with one example added by the
  test, so everything else stays the committed contract.
- **On the server side:** the App Service's own CI installs the latest published CLI and runs a
  smoke suite against a real server, so a server change that breaks a released CLI is caught there.

## Skills

Skills ship with the CLI and are part of its public contract. When adding or changing one, write it
against the rules below, update the table in [Skills](docs/skills.md), and add a changelog entry.

- The skill lint (`tests/skills/lint.test.ts`) enforces rules 1, 2, 5 and 6 of
  [Rules for skill content](#rules-for-skill-content), and refuses any skill or doc that names the
  internal recovery routes, a recovery mode, or the `action` field of an attention finding (the
  published finding has none).
- `tests/skills/imported.json` lists skills exempt from content validation because they were
  imported from a private repository and not yet ported to `pidgen` commands. It is empty: every
  bundled skill is ported. `npm run release:check` refuses a release while it lists anything,
  because imported text can contain private material. Never publish while it lists a skill.

### Skill format

Each skill is a directory with a `SKILL.md`:

```markdown
---
name: pidgen-manage-epics
description: One or two sentences an agent reads to decide when to use the skill.
---

# Create an epic
…
```

Keep the `name` equal to the directory name. The `description` is the trigger: say what the skill
does and when to use it, and name the neighbouring skill to use instead where they overlap.

### Rules for skill content

A skill runs on an end user's machine against the hosted service. It therefore:

1. **Calls only `pidgen` commands.** No `curl`, `wget`, `psql`, SQL, `docker exec`, raw `/api/v1/…`
   paths, or scripts from any Pidgen repository. If a skill needs something the CLI cannot do, the fix
   is a new command backed by a public API route. **One exception:** a skill may run the installed
   worker's own configuration commands (`pidgen-worker capacity` and `pidgen-worker subscriptions`)
   to change that worker's local `node.yaml`, which no API route reaches. Those commands print text,
   not a JSON envelope, so the skill says what their output and exit status mean. Where those
   commands do not cover a setting, a skill may edit the worker's local `node.yaml` or
   `worker-policy.yaml` using the published worker documentation, preserve unrelated settings and
   validate with the installed worker. Browsing public documentation does not authorize direct
   API calls or access to server internals.
2. **Names only commands that exist.** Every `pidgen …` invocation must match the command registry.
3. **Follows preview → apply.** Preview, reason about the plan, then apply with the digest received.
   Never pass `--ack` unless the preview listed that code and the skill says when accepting it is
   right ([Preview and apply](docs/preview-and-apply.md)).
4. **Explicitly selects JSON.** Pass `--format json` on every invocation that consumes structured
   responses, including examples executed in a terminal. Terminal stdout otherwise defaults to
   human-readable output; nonterminal stdout defaults to JSON. Refer to fields of the envelope's
   `data`, and branch on unchanged exit codes and `error.code`. `--format table` is for people.
5. **Contains nothing private.** No server internals (tables, internal services, file layouts),
   private hostnames, ports, local paths, user names, Account ids, or credentials.
6. **Never hardcodes an Account, profile, or server.** The profile decides.
7. **Keeps ticket completion machine-verifiable throughout.** Acceptance criteria, objectives,
   scope, assumptions, referenced plans and rework instructions cannot require a human review,
   sign-off or approval artifact. Evidence collection runs automatically; optional product review
   and adoption happen after delivery. Preserve meaningful evidence checks and explicit workflow
   approval/merge policies. Recovery must use the corrected ticket inputs rather than repeating
   a hidden human prerequisite.
8. **Splits cross-Project work along a contract.** Name the provider work and build consumer
   criteria against committed contracts and fixtures in the consumer's own workspace. Dependency
   edges cannot enforce cross-Project ordering. Live integration checks belong in the external QA
   plan, with environment prerequisites and preflight checks; never file integration-test tickets
   or make a live environment a hidden completion gate. Verify claims using public documentation,
   contracts or authorized QA evidence.

Rules 1, 2, 5 and 6 are checked automatically before every release.

### Reviewing worker support guidance

`pidgen-setup-worker` uses `https://docs.pidgen.ai` for current procedures and installed command
help for version compatibility. Keep its documentation links and scope aligned with the public
worker guides; do not copy a model catalog or a complete policy schema into the skill. Check links
when reviewing changes, separately from the test suite, which must never contact a real server.
Record missing public procedures instead of filling them from private implementation knowledge.

Skill lint checks syntax and command names, not operational judgment. For substantive worker-skill
changes, evaluate realistic requests against fake command results and documentation snapshots in
an isolated environment. Compare the proposed actions and reported evidence with these outcomes;
do not execute installs, logins, configuration edits or feedback against a customer's worker.
The reproducible cases in [worker-support-scenarios.json](tests/skills/worker-support-scenarios.json)
separate the request and observations from the grading expectations. Give the evaluator the
skill, named documentation snapshots, request and observations only; grade its concrete actions
afterwards. These are behavioral evaluations, not assertions that the skill contains certain words,
and they are not automatically run by `npm test`.

| Request and evidence | Expected behavior |
|---|---|
| Setup fails without a terminal; `TERMINAL_REQUIRED` includes commands | Uses the scriptable steps; does not claim that setup flags make it headless |
| Worker status exits 0, server view is unavailable, and a warning explains why | Reports local status and the missing connection evidence; does not re-enroll |
| A service runs the worker, but the shell resolves a different executable | Identifies the service's user, home and executable before proposing changes; starts no second manager |
| Raise a harness cap; the shared prompt pool is already saturated | Explains both limits, preserves other harnesses, and checks applied capacity rather than only command exit status |
| Capacity set exits 0 with `saved, apply pending` | Reads back the digest within the documented interval and reports pending if still unapplied; no endless polling or unnecessary restart |
| Enable a newly announced model; no Pidgen model procedure is documented | Separates provider, harness, worker and Account support; does not invent a model command, YAML key or successful execution |
| A new model works in shell Claude but not on the worker | Checks the actual service user and selected executable; uses the version-supported Claude `cli_path` policy, validates and restarts through the existing launch method |
| Customize a harness option whose policy key is undocumented | Requests the missing public reference; does not infer policy keys from provider CLI flags or weaken sandboxing |
| Add a second subscription; results include `duplicate` or `unknown` | Rejects duplicate quota assumptions, distinguishes unknown from logged out, preserves order and explains plan-dependent fallback |
| Remote primary selection returns `unknown` or `SUBSCRIPTION_STALE` | Reads subscriptions again before considering another change; does not blindly repeat a mutation |
| Documentation is unavailable or newer than installed help | States the limitation, continues supported diagnosis, and leaves unverified changes unresolved |
| Diagnosis fails and the user has not asked to send a report | Prepares a redacted support summary without submitting feedback |

After a CLI upgrade, verify skill installation and status using the existing command tests. The
model and policy guides are versioned against the public worker release's schema and annotated
example. When updating them, compare all documented keys, bounds and example values with those
public artifacts and validate the YAML snippets against that schema. Keep the worker package out
of this repository and its dependencies; do this source check separately from offline tests.
Update the skill's routing and the scenarios whenever the supported procedure changes.

## Documentation

- `docs/` is the user documentation. When behaviour changes, the matching page changes in the same
  commit. Mark anything not yet built as *planned*.
- Write for end users of a hosted service. Do not reference private design documents, internal
  plans, or the state of the work; state the decision instead.
- Contributor material belongs here, not in `docs/`.

### Structure and website publishing

`docs/` is the source of truth for CLI user documentation. Keep three levels:

| Level | Purpose | Pages |
|---|---|---|
| Getting started | Complete a first task, with prerequisites, commands, success checks, and recovery | `getting-started.md`, `install-skills.md`, `install-worker.md`, `troubleshooting.md` |
| Guides | Explain a workflow or concept after onboarding | Authentication, preview/apply, planning cohorts, architecture |
| Reference | Look up exact behavior, flags, result fields, and limitations | Commands, skills, workers, output/exit codes, API compatibility |

[`docs/navigation.json`](docs/navigation.json) defines the group order, page titles, and source
paths for website integration. Paths are relative to `docs/`; every user page appears once,
except `docs/README.md`, which is the documentation landing page. Keep the landing page's links
and navigation manifest aligned. Retain existing page filenames and heading anchors when possible
so published links continue to work.

The website renderer and deployment are *planned*. The manifest is independent of a site
framework; it does not build or publish a website. When integrating it:

- Publish the Getting started group in this order: CLI onboarding, skills, worker setup, troubleshooting.
- Render these Markdown sources rather than maintaining a second copy of the content.
- Translate relative `.md` links, including fragments, to the website's routes. Links to repository
  files outside `docs/` should point to the public repository instead.
- Preserve code blocks, tables, heading anchors, and the distinction between placeholders and
  executable examples. Use the page's first heading as its visible title.
- Give the landing page a route, and retain access to Guides and Reference from onboarding pages.

Before publishing, verify that the npm package is publicly installable and that the hosted server
supports sign-in, worker releases, and enrollment. Confirm a supported worker release is available.
Exercise the three onboarding paths from a fresh user environment; mocked command tests cannot
establish live service availability. Update availability notes to match that evidence, and keep
unsupported features marked *planned*.

For documentation changes, check local links and fragments, navigation coverage, command names
and flags against the registry, and formatting. Do not run examples that create work against a
real Account as part of repository tests.

## Platforms

CI runs the full test suite on Linux with the oldest supported Node (22) and the current one (24),
and on macOS with Node 24. Windows is best effort and not in CI: `pidgen worker` refuses with a
reason where the worker is unsupported.

## Commits and releases

- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, with `!` for breaking changes).
- Semantic versioning. A major version changes or removes commands, flags, envelope fields, exit
  codes, CLI error codes, or skills in an incompatible way.
- Releases are published to npm from GitHub Actions with provenance (`npm publish --provenance`);
  never publish from a workstation. `prepublishOnly` runs the release check. The changelog states
  the supported API version range.
- No telemetry. The CLI sends nothing anywhere except the requests a command makes to the configured
  Pidgen server.
