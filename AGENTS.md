# AGENTS.md

Instructions for coding agents and contributors working in this repository.

## What this repository is

This repository is the open-source command-line client for Pidgen. It publishes the `pidgen` package and command to npm and bundles the Pidgen agent skills. Start with
[`docs/README.md`](docs/README.md); [`docs/architecture.md`](docs/architecture.md) explains the
boundaries below.

`docs/` is the user documentation and the reference the CLI is built against. When behaviour
changes, update the matching page in the same change. Contributor material belongs in
[`CONTRIBUTING.md`](CONTRIBUTING.md), not in `docs/`.

## Boundaries — never cross these

1. **This repository is public.** Never add private material to code, docs, tests, fixtures, commit
   messages, or skills: App Service internals (database tables, internal services, internal file
   layouts, private repository names or paths), private hostnames or ports, user names, Account ids,
   tokens, or other credentials. Use `pidgen.example.com`, `ACC-EXAMPLE`, and obviously fake tokens.
   That includes the worker's repository: the CLI never names it. The publisher identity the CLI
   verifies worker releases against, in `src/core/worker-release-identities.ts`, names only the
   `pidgen-ai` GitHub organization (a `release.yml` workflow in any of its repositories). The
   worker's package and command, `pidgen-worker`, are its public names. Tests and fixtures use
   `example-org` identities.
2. **Public API only.** The CLI talks to the App Service exclusively through routes in
   `contracts/openapi.json`. Never read a database, never call a route that is not in the public
   document, and never depend on App Service source code. When a command needs something the public
   API lacks, stop and record the missing route; do not work around it. **One exception:** a route
   the App Service has agreed but not yet published may stand in as a pending fragment under
   `contracts/pending/` (an OpenAPI document holding only that route and its schemas), with its
   types generated from it, responses validated against it, and contract tests served from it by
   the Prism mock. When the server publishes the route, it is pulled with the public document and
   the fragment is deleted. There are two today: `contracts/pending/worker-enrollments.json` (the
   install id on the enrollment create and the worker list, the caller's enrollment list, and the
   enrollment withdraw) and `contracts/pending/project-readiness.json` (a Project's readiness, its
   proposal archive and pull request, answers, rehearsal and the Project doctor). The worker release, domain, Domain Epic, contract, contract creation,
   contract publishing and Request routes are published, and their fragments are deleted.
3. **The worker is separate.** Never bundle, pin, vendor, or import `pidgen-worker`. `pidgen worker`
   commands run the installed `pidgen-worker` as a subprocess, and the CLI never stores the credential.
4. **No telemetry.** The CLI sends nothing anywhere except the requests a command makes to the
   configured Pidgen server.

## Stack

TypeScript 5.9, Node.js ≥ 22.12, ES modules. `commander` for commands, `zod` for validation,
`openapi-typescript` for API types, `tsup` for the bundle, `vitest` for tests. Add a runtime
dependency only with a stated reason; startup time and supply-chain size matter. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

- Never hand-edit `src/generated/`. Regenerate it from `contracts/openapi.json`
  ([`docs/api-compatibility.md`](docs/api-compatibility.md)).
- Keep one module per command under `src/commands/<noun>/`, listed in `src/commands/index.ts`.

## The CLI contract

These are public and versioned. Changing any of them incompatibly is a major release.

- **Output:** terminal stdout defaults to human-readable output; nonterminal stdout defaults to
  exactly one JSON envelope (`{ok, data, error, meta}`). `--format json` and `--format table`
  override selection, including usage errors. Keep JSON payloads and exit codes unchanged.
  Help/version are text and foreground `worker start` inherits the worker's streams and status;
  standard error retains progress and documented subprocess output
  ([`docs/output-and-exit-codes.md`](docs/output-and-exit-codes.md)).
- **Exit codes:** 0 ok, 1 unexpected, 2 usage, 3 auth, 4 not found, 5 refusal/conflict,
  6 digest or acknowledgement required, 7 API version incompatible, 8 network/timeout.
- **No prompts.** Commands never ask questions. `pidgen setup`, the guided path from a fresh machine
  to a running worker, is the only interactive command: it asks only on a terminal, its flags answer
  its questions in advance, and without a terminal it exits 2 with `TERMINAL_REQUIRED` and the
  equivalent scriptable commands. Every other command, `pidgen worker enroll` included, never asks.
- **Preview before apply.** Commands with side effects preview by default and apply only with
  `--apply`, the preview's `--digest`, and explicit `--ack` codes. Never add an acknowledgement on
  the caller's behalf ([`docs/preview-and-apply.md`](docs/preview-and-apply.md)).
- **Commands:** `pidgen <noun> <verb>` as listed in [`docs/commands.md`](docs/commands.md). A new
  command is added to that page, the registry, and tests in the same change.

## Skills

Skills live in `skills/<name>/SKILL.md` and ship in the npm package
([`docs/skills.md`](docs/skills.md)).

- A skill calls only `pidgen` commands that exist, follows preview → apply, explicitly selects `--format json` when reading structured responses, and contains
  nothing private. The skill lint (`tests/skills/lint.test.ts`) enforces this; exemptions are in `tests/skills/imported.json`.
- Skills listed in `tests/skills/imported.json` are exempt from content validation and must not be
  published. When you port one, remove its exemption in the same change. The list is empty.
- A skill change is a contract change: note it in the changelog.

## Tests

- Every command has tests for success, at least one server refusal, and its usage errors, and checks
  the envelope and exit code.
- Contract tests run against the Prism mock server built from `contracts/openapi.json`.
- Tests never contact a real Pidgen server and never contain real hostnames, Account ids, or tokens.
- Run `npm test`, `npm run lint`, and `npm run typecheck` before proposing a change.

## Documentation

- `docs/` is the user documentation. Keep it accurate: when behaviour changes, the matching page
  changes in the same commit. It describes what the CLI does, never how the work is planned or
  tracked.
- Mark anything not yet built as *planned*.
- Write for end users of a hosted service. Do not reference private design documents; state the
  decision here instead.

## Commits and releases

Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `!` for breaking). Semantic versioning.
Releases publish to npm from CI with provenance; never publish from a workstation.

